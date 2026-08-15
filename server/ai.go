package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"

	"webface.cloud/platform/pbbrand"
)

// resolvePlan is the single authority for a user's tier. Comp (owner) accounts
// listed in WFC_COMP_EMAILS never pay and always get the top model; everyone
// else is "free" until Stripe (Phase 3) can flip them to "paid".
func resolvePlan(user *core.Record) string {
	if user == nil {
		return "free"
	}
	email := strings.ToLower(strings.TrimSpace(user.Email()))
	comp := os.Getenv("WFC_COMP_EMAILS")
	if comp == "" {
		comp = "tommyadeniyi@gmail.com,tommy@webfacemedia.com"
	}
	for _, e := range strings.Split(comp, ",") {
		if email != "" && strings.ToLower(strings.TrimSpace(e)) == email {
			return "comp"
		}
	}
	// paid status (set by the Stripe webhook) — field may not exist yet.
	if user.GetString("plan") == "paid" {
		return "paid"
	}
	return "free"
}

func modelForPlan(plan string) string {
	paid := envOr("AI_MODEL_PAID", "claude-opus-5")
	free := envOr("AI_MODEL_FREE", "claude-sonnet-5")
	if plan == "comp" || plan == "paid" {
		return paid
	}
	return free
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

// ---- candidate selection ----

type candidate struct {
	ID, ExID, Name, Target, Category, Equipment string
}

const (
	// candidateFetchCap bounds the DB read. It must exceed the seeded catalogue
	// (1,324 exercises) so the pool is never truncated before selection.
	//
	// This was 800 with sort "name". A gym owning enough equipment to match
	// more than 800 rows silently lost everything alphabetically after the
	// cutoff — so the diversity spread below drew from an A–S subset and the
	// model was never offered a Triceps Pushdown or an Upright Row. Alphabetical
	// truncation is invisible in the output: you get a plausible plan built
	// from half the catalogue.
	candidateFetchCap = 2000

	// promptCandidates is the number sent to the model. This cap is a real
	// cost decision (each line is ~20 tokens) and stays.
	promptCandidates = 150

	// perTargetRounds bounds how many exercises one muscle group can contribute
	// before others get a turn.
	perTargetRounds = 8

	// goalRelevantShare is how much of the prompt budget BM25-ranked,
	// goal-relevant exercises may claim. The rest stays with the diversity
	// spread — a plan built ONLY from "shoulders" hits is a worse plan, so
	// relevance supplements balance rather than replacing it.
	goalRelevantShare = 0.4
)

// equipmentFilter builds the owned-equipment predicate shared by both paths.
func equipmentFilter(equipment []string, col string) (string, dbx.Params) {
	parts := make([]string, len(equipment))
	params := dbx.Params{}
	for i, e := range equipment {
		key := fmt.Sprintf("e%d", i)
		parts[i] = col + " = {:" + key + "}"
		params[key] = e
	}
	return strings.Join(parts, " || "), params
}

// selectCandidates returns owned-equipment exercises the model may prescribe.
//
// Two concerns, in order:
//
//  1. RELEVANCE — if FTS5 search is enabled and the user stated a goal
//     ("upper body hypertrophy, focus on shoulders"), BM25-rank the catalogue
//     against that text and put the best matches in first. Without this the
//     goal never influenced WHICH exercises the model could choose from; it
//     only ever saw an equipment-filtered, alphabetically-biased sample and had
//     to do all the interpreting itself.
//  2. BALANCE — fill the rest by round-robin across target muscles, so a
//     goal-shaped prompt still contains enough of the body to build a week.
//
// Grounding the model in real ex_ids is what keeps generated plans valid, so
// both paths return records that actually exist.
//
// Degrades cleanly: WFC_SEARCH_ENABLED is OFF by default and the exercises
// index may not exist, so a search failure is never fatal — it falls back to
// the equipment-only behaviour that shipped before.
func selectCandidates(app core.App, equipment []string, goal string) ([]candidate, error) {
	if len(equipment) == 0 {
		return nil, nil
	}

	filter, params := equipmentFilter(equipment, "equipment")
	recs, err := app.FindRecordsByFilter("exercises", filter, "name", candidateFetchCap, 0, params)
	if err != nil {
		return nil, err
	}

	byID := map[string]candidate{}
	byTarget := map[string][]candidate{}
	order := []string{}
	for _, r := range recs {
		c := candidate{
			ID: r.Id, ExID: r.GetString("ex_id"), Name: r.GetString("name"),
			Target: r.GetString("target"), Category: r.GetString("category"),
			Equipment: r.GetString("equipment"),
		}
		byID[c.ID] = c
		if _, ok := byTarget[c.Target]; !ok {
			order = append(order, c.Target)
		}
		byTarget[c.Target] = append(byTarget[c.Target], c)
	}
	sort.Strings(order)

	out := []candidate{}
	seen := map[string]bool{}
	add := func(c candidate) bool {
		if seen[c.ID] || len(out) >= promptCandidates {
			return false
		}
		seen[c.ID] = true
		out = append(out, c)
		return true
	}

	// 1. Goal-relevant, BM25-ranked.
	for _, c := range goalRankedCandidates(app, equipment, goal, byID) {
		if len(out) >= int(promptCandidates*goalRelevantShare) {
			break
		}
		add(c)
	}

	// 2. Diversity spread across targets fills the remainder.
	for round := 0; round < perTargetRounds && len(out) < promptCandidates; round++ {
		for _, t := range order {
			if round < len(byTarget[t]) {
				add(byTarget[t][round])
			}
			if len(out) >= promptCandidates {
				break
			}
		}
	}
	return out, nil
}

// goalRankedCandidates BM25-ranks the owned-equipment catalogue against the
// user's goal text. Returns nil (not an error) whenever search is unavailable —
// the caller treats relevance as a bonus, never a requirement.
func goalRankedCandidates(app core.App, equipment []string, goal string, byID map[string]candidate) []candidate {
	if strings.TrimSpace(goal) == "" || !pbbrand.SearchEnabled() {
		return nil
	}
	// Restrict the ranked set to equipment the user actually owns. The filter
	// runs against the source table (aliased `src` by SearchCollection).
	filter, params := equipmentFilter(equipment, "src.equipment")

	// ANY (OR), not ALL. A goal is a sentence, not a search box: "shoulder
	// press for delts" contains "for", which appears in no exercise, and
	// requiring every token drops the result set to zero — verified, this was
	// the first cut of this function returning nothing at all. With OR, BM25
	// ranks by how much of the goal each exercise matches and noise words
	// simply contribute nothing.
	hits, err := pbbrand.SearchCollectionAny(app, "exercises", goal, promptCandidates, filter, params)
	if err != nil {
		// Index missing, search disabled mid-flight, or a malformed goal —
		// none of which should stop someone generating a plan.
		app.Logger().Warn("ai: goal-ranked candidates unavailable, using equipment spread only", "err", err)
		return nil
	}
	out := make([]candidate, 0, len(hits))
	for _, h := range hits {
		if c, ok := byID[h.ID]; ok {
			out = append(out, c)
		}
	}
	return out
}

// ---- Claude call (raw Messages API; key stays server-side) ----

type planReq struct {
	Goal           string `json:"goal"`
	DaysPerWeek    int    `json:"days_per_week"`
	Experience     string `json:"experience"`
	Injuries       string `json:"injuries"`
	SessionMinutes int    `json:"session_minutes"`
}

type planItem struct {
	ExID      string `json:"ex_id"`
	Sets      int    `json:"sets"`
	Reps      int    `json:"reps"`
	Rationale string `json:"rationale"`
}
type planWorkout struct {
	Name     string     `json:"name"`
	DayLabel string     `json:"day_label"`
	Items    []planItem `json:"items"`
}
type planOut struct {
	Workouts []planWorkout `json:"workouts"`
}

var planSchema = map[string]any{
	"type":                 "object",
	"additionalProperties": false,
	"required":             []string{"workouts"},
	"properties": map[string]any{
		"workouts": map[string]any{
			"type": "array",
			"items": map[string]any{
				"type":                 "object",
				"additionalProperties": false,
				"required":             []string{"name", "day_label", "items"},
				"properties": map[string]any{
					"name":      map[string]any{"type": "string"},
					"day_label": map[string]any{"type": "string"},
					"items": map[string]any{
						"type": "array",
						"items": map[string]any{
							"type":                 "object",
							"additionalProperties": false,
							"required":             []string{"ex_id", "sets", "reps", "rationale"},
							"properties": map[string]any{
								"ex_id":     map[string]any{"type": "string"},
								"sets":      map[string]any{"type": "integer"},
								"reps":      map[string]any{"type": "integer"},
								"rationale": map[string]any{"type": "string"},
							},
						},
					},
				},
			},
		},
	},
}

// callClaudeJSON calls the Messages API with a JSON-schema output constraint and
// returns the raw JSON text of the first content block. Key stays server-side.
func callClaudeJSON(model, system, user string, schema map[string]any) (string, error) {
	key := os.Getenv("ANTHROPIC_API_KEY")
	if key == "" {
		return "", fmt.Errorf("AI is not configured yet (no ANTHROPIC_API_KEY)")
	}
	body := map[string]any{
		"model":      model,
		"max_tokens": 8000,
		"system":     system,
		"messages":   []any{map[string]any{"role": "user", "content": user}},
	}
	if schema != nil {
		body["output_config"] = map[string]any{
			"format": map[string]any{"type": "json_schema", "schema": schema},
		}
	}
	buf, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "https://api.anthropic.com/v1/messages", bytes.NewReader(buf))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-api-key", key)
	req.Header.Set("anthropic-version", "2023-06-01")

	client := &http.Client{Timeout: 90 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", fmt.Errorf("calling Claude: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("Claude API %d: %s", resp.StatusCode, tailStr(string(raw), 300))
	}
	var out struct {
		StopReason string `json:"stop_reason"`
		Content    []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return "", fmt.Errorf("decoding Claude response: %w", err)
	}
	if out.StopReason == "refusal" {
		return "", fmt.Errorf("the model declined this request")
	}
	for _, c := range out.Content {
		if c.Type == "text" && c.Text != "" {
			return c.Text, nil
		}
	}
	return "", fmt.Errorf("empty response from the model")
}

func tailStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
}

// extractJSON returns the outermost {...} object from a possibly prose-wrapped
// or ```json-fenced response.
func extractJSON(s string) string {
	i := strings.Index(s, "{")
	j := strings.LastIndex(s, "}")
	if i >= 0 && j > i {
		return s[i : j+1]
	}
	return s
}

// ---- route handlers ----

func handleAIPlan(app core.App) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		if e.Auth == nil {
			return e.UnauthorizedError("sign in first", nil)
		}
		uid := e.Auth.Id

		var body planReq
		if err := e.BindBody(&body); err != nil {
			return e.BadRequestError("bad request body", err)
		}
		if body.DaysPerWeek < 1 || body.DaysPerWeek > 7 {
			body.DaysPerWeek = 3
		}

		// owned equipment
		gp, err := app.FindFirstRecordByFilter("gym_profiles", "owner = {:o}", dbx.Params{"o": uid})
		if err != nil {
			return e.BadRequestError("Set up your gym first (My Gym) so plans use your equipment.", nil)
		}
		equipment := jsonStrings(gp.Get("equipment"))
		if len(equipment) == 0 {
			// PocketBase json fields come back as types.JSONRaw ([]byte); read the
			// serialized string and unmarshal as a fallback.
			_ = json.Unmarshal([]byte(gp.GetString("equipment")), &equipment)
		}
		if len(equipment) == 0 {
			return e.BadRequestError("Your gym has no equipment yet — add some in My Gym.", nil)
		}

		// Goal + injuries steer WHICH exercises the model may choose from, not
		// just how it uses them. Injuries are included so "bad shoulder" biases
		// retrieval toward what it mentions; the model still does the excluding.
		cands, err := selectCandidates(app, equipment, body.Goal+" "+body.Injuries)
		if err != nil {
			return e.InternalServerError("could not load exercises", err)
		}
		if len(cands) == 0 {
			return e.BadRequestError("No exercises match your equipment.", nil)
		}
		validIDs := map[string]candidate{}
		var b strings.Builder
		for _, c := range cands {
			validIDs[c.ExID] = c
			fmt.Fprintf(&b, "%s | %s | target:%s | %s\n", c.ExID, c.Name, c.Target, c.Equipment)
		}

		plan := resolvePlan(e.Auth)
		model := modelForPlan(plan)

		system := "You are a strength & conditioning coach building a weekly training plan for a home-gym client. " +
			"You MUST only prescribe exercises from the provided candidate list, referenced by their exact ex_id. " +
			"Never invent an ex_id. Balance muscle groups across the week, respect the client's experience and any injuries, " +
			"and choose sensible sets/reps for the goal. Keep each session within the time budget." +
			langInstruction(e.Auth)
		user := fmt.Sprintf(
			"Goal: %s\nDays per week: %d\nExperience: %s\nInjuries/limits: %s\nSession minutes: %d\n\n"+
				"Candidate exercises (ex_id | name | target | equipment):\n%s\n"+
				"Produce %d workouts (one per training day), each with a short name, a day_label, and 4-7 items. "+
				"Each item: ex_id (from the list), sets, reps, and a one-line rationale.",
			body.Goal, body.DaysPerWeek, body.Experience, emptyDash(body.Injuries), body.SessionMinutes, b.String(), body.DaysPerWeek)

		col, err := app.FindCollectionByNameOrId("workouts")
		if err != nil {
			return e.InternalServerError("workouts collection missing", err)
		}

		// The model occasionally returns an all-invalid (thus empty) plan — retry
		// a couple of times before giving up. The failure path persists nothing
		// (workouts are only saved once they have valid items), so no duplicates.
		var created []map[string]any
		var lastErr error
		for attempt := 0; attempt < 3 && len(created) == 0; attempt++ {
			text, err := callClaudeJSON(model, system, user, planSchema)
			if err != nil {
				lastErr = err
				continue
			}
			var out planOut
			if err := json.Unmarshal([]byte(text), &out); err != nil {
				lastErr = fmt.Errorf("plan was not valid JSON")
				continue
			}
			for _, w := range out.Workouts {
				items := []map[string]any{}
				for _, it := range w.Items {
					c, ok := validIDs[it.ExID]
					if !ok {
						continue // drop hallucinated ex_id
					}
					full, err := app.FindFirstRecordByFilter("exercises", "ex_id = {:x}", dbx.Params{"x": it.ExID})
					if err != nil {
						continue
					}
					sets := it.Sets
					if sets < 1 {
						sets = 3
					}
					reps := it.Reps
					if reps < 1 {
						reps = 10
					}
					items = append(items, map[string]any{
						"id": full.Id, "ex_id": c.ExID, "name": c.Name, "target": c.Target,
						"image": full.GetString("image"), "gif_url": full.GetString("gif_url"),
						"sets": sets, "reps": reps,
					})
				}
				if len(items) == 0 {
					continue
				}
				name := strings.TrimSpace(w.Name)
				if name == "" {
					name = "AI Workout"
				}
				if w.DayLabel != "" {
					name = w.DayLabel + " · " + name
				}
				rec := core.NewRecord(col)
				rec.Set("owner", uid)
				rec.Set("name", name)
				rec.Set("items", items)
				if err := app.Save(rec); err != nil {
					return e.InternalServerError("saving workout", err)
				}
				created = append(created, map[string]any{"id": rec.Id, "name": name, "items": len(items)})
			}
		}
		if len(created) == 0 {
			if lastErr != nil {
				return e.InternalServerError(lastErr.Error(), lastErr)
			}
			return e.InternalServerError("the model produced no usable workouts — try again", nil)
		}
		return e.JSON(200, map[string]any{"created": created, "model": model, "plan": plan})
	}
}

// ---- progression ----

var progressSchema = map[string]any{
	"type":                 "object",
	"additionalProperties": false,
	"required":             []string{"items"},
	"properties": map[string]any{
		"items": map[string]any{
			"type": "array",
			"items": map[string]any{
				"type":                 "object",
				"additionalProperties": false,
				"required":             []string{"ex_id", "next_sets", "next_reps", "suggested_weight", "note"},
				"properties": map[string]any{
					"ex_id":            map[string]any{"type": "string"},
					"next_sets":        map[string]any{"type": "integer"},
					"next_reps":        map[string]any{"type": "integer"},
					"suggested_weight": map[string]any{"type": "string"},
					"note":             map[string]any{"type": "string"},
				},
			},
		},
	},
}

type progressItem struct {
	ExID            string `json:"ex_id"`
	NextSets        int    `json:"next_sets"`
	NextReps        int    `json:"next_reps"`
	SuggestedWeight string `json:"suggested_weight"`
	Note            string `json:"note"`
}

func handleAIProgress(app core.App) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		if e.Auth == nil {
			return e.UnauthorizedError("sign in first", nil)
		}
		uid := e.Auth.Id
		var body struct {
			WorkoutID string `json:"workout_id"`
		}
		if err := e.BindBody(&body); err != nil || body.WorkoutID == "" {
			return e.BadRequestError("workout_id required", nil)
		}
		w, err := app.FindRecordById("workouts", body.WorkoutID)
		if err != nil || w.GetString("owner") != uid {
			return e.NotFoundError("workout not found", nil)
		}
		var items []map[string]any
		_ = json.Unmarshal([]byte(w.GetString("items")), &items)
		if len(items) == 0 {
			return e.BadRequestError("this workout has no exercises", nil)
		}

		// recent logged sessions, filtered to this workout in Go (relation-field
		// filters were unreliable here; owner scope + Go match is robust).
		all, _ := app.FindRecordsByFilter("sessions", "owner = {:o}", "-created", 40, 0, dbx.Params{"o": uid})
		sess := []*core.Record{}
		for _, s := range all {
			// the sessions collection links the workout via a text field, workout_ref
			if s.GetString("workout_ref") == body.WorkoutID {
				sess = append(sess, s)
			}
			if len(sess) >= 5 {
				break
			}
		}

		// per-exercise logged history (most recent first)
		hist := map[string][]string{}
		for _, s := range sess {
			var entries []struct {
				ExID string `json:"ex_id"`
				Name string `json:"name"`
				Sets []struct {
					Reps   any `json:"reps"`
					Weight any `json:"weight"`
				} `json:"sets"`
			}
			_ = json.Unmarshal([]byte(s.GetString("entries")), &entries)
			for _, en := range entries {
				parts := []string{}
				for _, st := range en.Sets {
					parts = append(parts, fmt.Sprintf("%v×%v", st.Reps, st.Weight))
				}
				if len(parts) > 0 {
					hist[en.ExID] = append(hist[en.ExID], strings.Join(parts, ", "))
				}
			}
		}

		// build the prompt: current targets + logged history per exercise
		var b strings.Builder
		for _, it := range items {
			ex := fmt.Sprintf("%v", it["ex_id"])
			fmt.Fprintf(&b, "%s | %v | target %v×%v", ex, it["name"], it["sets"], it["reps"])
			if h := hist[ex]; len(h) > 0 {
				fmt.Fprintf(&b, " | logged (recent first): %s", strings.Join(h, "  //  "))
			} else {
				b.WriteString(" | no logs yet")
			}
			b.WriteString("\n")
		}

		model := modelForPlan(resolvePlan(e.Auth))
		system := "You are a strength coach reviewing a client's workout and their recent logged sets " +
			"(reps×weight). For EVERY exercise, suggest the next session's target sets/reps and a working weight, " +
			"applying progressive overload from the current target: nudge reps or weight up when the last sets were " +
			"completed comfortably, hold or deload if they missed reps, and when there are no logs yet keep the same " +
			"sets/reps and suggest a sensible starting weight. Reuse each exercise's exact ex_id. Never omit an " +
			"exercise and never leave a field empty. suggested_weight is a short human string like \"22.5 kg\", " +
			"\"+2.5 kg\", or \"bodyweight\"." +
			langInstruction(e.Auth)
		exIDs := make([]string, len(items))
		for i, it := range items {
			exIDs[i] = fmt.Sprintf("%v", it["ex_id"])
		}
		user := fmt.Sprintf("Workout exercises (ex_id | name | current target | logged history):\n%s\n"+
			"Return an items array containing EXACTLY these %d ex_ids, in this order: %s\n"+
			"Produce one object per ex_id (no duplicates, no omissions). Each: next_sets and next_reps as positive "+
			"integers, suggested_weight as a short non-empty string, note as one short line. "+
			"Never leave a field empty and never use the word \"placeholder\".\n\n"+
			"Respond with ONLY a JSON object of the form "+
			"{\"items\":[{\"ex_id\":\"..\",\"next_sets\":N,\"next_reps\":N,\"suggested_weight\":\"..\",\"note\":\"..\"}]} "+
			"— no markdown, no prose before or after.",
			b.String(), len(items), strings.Join(exIDs, ", "))

		// Plain JSON (no structured-output schema): on this route the schema mode
		// degenerated to a single item; a JSON-only instruction enumerates reliably.
		text, err := callClaudeJSON(model, system, user, nil)
		if err != nil {
			return e.InternalServerError(err.Error(), err)
		}
		var out struct {
			Items []progressItem `json:"items"`
		}
		if err := json.Unmarshal([]byte(extractJSON(text)), &out); err != nil {
			return e.InternalServerError("progression was not valid JSON", err)
		}
		// only return suggestions for exercises actually in the workout
		valid := map[string]bool{}
		for _, it := range items {
			valid[fmt.Sprintf("%v", it["ex_id"])] = true
		}
		kept := out.Items[:0]
		seen := map[string]bool{}
		for _, s := range out.Items {
			if valid[s.ExID] && !seen[s.ExID] {
				seen[s.ExID] = true
				if s.NextSets < 1 {
					s.NextSets = 3
				}
				if s.NextReps < 1 {
					s.NextReps = 10
				}
				kept = append(kept, s)
			}
		}
		return e.JSON(200, map[string]any{"items": kept, "model": model})
	}
}

func emptyDash(s string) string {
	if strings.TrimSpace(s) == "" {
		return "none"
	}
	return s
}

// jsonStrings coerces a PocketBase json field into []string.
func jsonStrings(v any) []string {
	switch t := v.(type) {
	case []string:
		return t
	case []any:
		out := make([]string, 0, len(t))
		for _, x := range t {
			if s, ok := x.(string); ok {
				out = append(out, s)
			}
		}
		return out
	case string:
		var out []string
		if json.Unmarshal([]byte(t), &out) == nil {
			return out
		}
	case json.RawMessage:
		var out []string
		if json.Unmarshal(t, &out) == nil {
			return out
		}
	}
	return nil
}
