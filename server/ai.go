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

// selectCandidates returns owned-equipment exercises with a spread across
// target muscles, capped so the prompt stays cheap. Grounding the model in real
// ex_ids is what keeps generated plans valid.
func selectCandidates(app core.App, equipment []string) ([]candidate, error) {
	if len(equipment) == 0 {
		return nil, nil
	}
	// filter: equipment = {:e0} || equipment = {:e1} ...
	parts := make([]string, len(equipment))
	params := dbx.Params{}
	for i, e := range equipment {
		key := fmt.Sprintf("e%d", i)
		parts[i] = "equipment = {:" + key + "}"
		params[key] = e
	}
	recs, err := app.FindRecordsByFilter("exercises", strings.Join(parts, " || "), "name", 800, 0, params)
	if err != nil {
		return nil, err
	}
	byTarget := map[string][]candidate{}
	order := []string{}
	for _, r := range recs {
		c := candidate{
			ID: r.Id, ExID: r.GetString("ex_id"), Name: r.GetString("name"),
			Target: r.GetString("target"), Category: r.GetString("category"),
			Equipment: r.GetString("equipment"),
		}
		if _, ok := byTarget[c.Target]; !ok {
			order = append(order, c.Target)
		}
		byTarget[c.Target] = append(byTarget[c.Target], c)
	}
	sort.Strings(order)
	// round-robin up to 8 per target, cap 150 total
	out := []candidate{}
	for round := 0; round < 8 && len(out) < 150; round++ {
		for _, t := range order {
			if round < len(byTarget[t]) {
				out = append(out, byTarget[t][round])
				if len(out) >= 150 {
					break
				}
			}
		}
	}
	return out, nil
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

func callClaudePlan(model, system, user string) (*planOut, error) {
	key := os.Getenv("ANTHROPIC_API_KEY")
	if key == "" {
		return nil, fmt.Errorf("AI is not configured yet (no ANTHROPIC_API_KEY)")
	}
	body := map[string]any{
		"model":      model,
		"max_tokens": 8000,
		"system":     system,
		"messages":   []any{map[string]any{"role": "user", "content": user}},
		"output_config": map[string]any{
			"format": map[string]any{"type": "json_schema", "schema": planSchema},
		},
	}
	buf, _ := json.Marshal(body)
	req, _ := http.NewRequest("POST", "https://api.anthropic.com/v1/messages", bytes.NewReader(buf))
	req.Header.Set("content-type", "application/json")
	req.Header.Set("x-api-key", key)
	req.Header.Set("anthropic-version", "2023-06-01")

	client := &http.Client{Timeout: 90 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("calling Claude: %w", err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		return nil, fmt.Errorf("Claude API %d: %s", resp.StatusCode, tailStr(string(raw), 300))
	}
	var out struct {
		StopReason string `json:"stop_reason"`
		Content    []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(raw, &out); err != nil {
		return nil, fmt.Errorf("decoding Claude response: %w", err)
	}
	if out.StopReason == "refusal" {
		return nil, fmt.Errorf("the model declined to generate this plan")
	}
	var text string
	for _, c := range out.Content {
		if c.Type == "text" {
			text = c.Text
			break
		}
	}
	if text == "" {
		return nil, fmt.Errorf("empty plan from the model")
	}
	var plan planOut
	if err := json.Unmarshal([]byte(text), &plan); err != nil {
		return nil, fmt.Errorf("plan was not valid JSON: %w", err)
	}
	return &plan, nil
}

func tailStr(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[len(s)-n:]
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

		cands, err := selectCandidates(app, equipment)
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
			"and choose sensible sets/reps for the goal. Keep each session within the time budget."
		user := fmt.Sprintf(
			"Goal: %s\nDays per week: %d\nExperience: %s\nInjuries/limits: %s\nSession minutes: %d\n\n"+
				"Candidate exercises (ex_id | name | target | equipment):\n%s\n"+
				"Produce %d workouts (one per training day), each with a short name, a day_label, and 4-7 items. "+
				"Each item: ex_id (from the list), sets, reps, and a one-line rationale.",
			body.Goal, body.DaysPerWeek, body.Experience, emptyDash(body.Injuries), body.SessionMinutes, b.String(), body.DaysPerWeek)

		out, err := callClaudePlan(model, system, user)
		if err != nil {
			return e.InternalServerError(err.Error(), err)
		}

		// validate + persist
		col, err := app.FindCollectionByNameOrId("workouts")
		if err != nil {
			return e.InternalServerError("workouts collection missing", err)
		}
		created := []map[string]any{}
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
		if len(created) == 0 {
			return e.InternalServerError("the model produced no usable workouts — try again", nil)
		}
		return e.JSON(200, map[string]any{"created": created, "model": model, "plan": plan})
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
