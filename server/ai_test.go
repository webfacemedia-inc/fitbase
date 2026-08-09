package main

import (
	"fmt"
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tests"

	"webface.cloud/platform/pbbrand"
)

// newTestApp gives a real, fully-migrated PocketBase on a temp dir. The
// candidate selection is all SQL and FTS5, so a mock would prove nothing.
func newTestApp(t *testing.T) core.App {
	t.Helper()
	app, err := tests.NewTestApp()
	if err != nil {
		t.Fatalf("test app: %v", err)
	}
	t.Cleanup(func() { app.Cleanup() })
	return app
}

// seedExercises builds the real exercises shape and fills it.
//
// Names are zero-padded and ordered so the alphabetical cutoff is exact and
// testable: everything from index 800 on sorts AFTER the old 800-row limit.
func seedExercises(t *testing.T, app core.App, n int) *core.Collection {
	t.Helper()
	col := core.NewBaseCollection("exercises")
	col.Fields.Add(
		&core.TextField{Name: "ex_id", Max: 40},
		&core.TextField{Name: "name", Max: 200},
		&core.TextField{Name: "category", Max: 60},
		&core.TextField{Name: "body_part", Max: 60},
		&core.TextField{Name: "equipment", Max: 60},
		&core.TextField{Name: "target", Max: 60},
		&core.TextField{Name: "muscle_group", Max: 60},
		&core.AutodateField{Name: "created", OnCreate: true},
	)
	if err := app.Save(col); err != nil {
		t.Fatalf("create exercises: %v", err)
	}

	for i := 0; i < n; i++ {
		r := core.NewRecord(col)
		// Sorts strictly by index, so "which rows survive an alphabetical
		// truncation" is unambiguous.
		r.Set("ex_id", fmt.Sprintf("ex%04d", i))
		r.Set("equipment", "barbell")
		if i >= 800 {
			// The late-alphabet tail the old 800-row cap silently discarded.
			r.Set("name", fmt.Sprintf("Z%04d Triceps Pushdown", i))
			r.Set("target", "triceps")
			r.Set("body_part", "upper arms")
			r.Set("muscle_group", "arms")
			r.Set("category", "strength")
		} else if i%7 == 0 {
			r.Set("name", fmt.Sprintf("A%04d Shoulder Press", i))
			r.Set("target", "deltoids")
			r.Set("body_part", "shoulders")
			r.Set("muscle_group", "shoulders")
			r.Set("category", "strength")
		} else {
			r.Set("name", fmt.Sprintf("A%04d Leg Extension", i))
			r.Set("target", "quadriceps")
			r.Set("body_part", "upper legs")
			r.Set("muscle_group", "legs")
			r.Set("category", "strength")
		}
		if err := app.Save(r); err != nil {
			t.Fatalf("seed exercise %d: %v", i, err)
		}
	}
	return col
}

func targetsIn(cands []candidate) map[string]int {
	out := map[string]int{}
	for _, c := range cands {
		out[c.Target]++
	}
	return out
}

// TestLateAlphabetExercisesAreReachable is the regression test for the real
// defect: the old query was `sort:"name" limit:800`, so on a catalogue larger
// than 800 rows every exercise sorting after the cutoff was invisible to the
// AI coach. The bug is silent — you still get a plausible plan, built from a
// truncated half of the catalogue.
func TestLateAlphabetExercisesAreReachable(t *testing.T) {
	app := newTestApp(t)
	seedExercises(t, app, 900) // 900 > the old 800 cap

	cands, err := selectCandidates(app, []string{"barbell"}, "")
	if err != nil {
		t.Fatalf("selectCandidates: %v", err)
	}
	if len(cands) == 0 {
		t.Fatal("no candidates")
	}

	byTarget := targetsIn(cands)
	if byTarget["triceps"] == 0 {
		t.Fatalf("no triceps exercise reached the model — the late-alphabet tail "+
			"(rows 800+) is still being truncated. targets: %v", byTarget)
	}
	// And the fetch cap must actually clear the catalogue.
	if candidateFetchCap <= 900 {
		t.Fatalf("candidateFetchCap %d does not clear the seeded catalogue", candidateFetchCap)
	}
}

// TestCandidatesRespectOwnedEquipment: the model must never be offered an
// exercise the user has no equipment for.
func TestCandidatesRespectOwnedEquipment(t *testing.T) {
	app := newTestApp(t)
	col := seedExercises(t, app, 50)

	r := core.NewRecord(col)
	r.Set("ex_id", "ex9999")
	r.Set("name", "Cable Fly")
	r.Set("equipment", "cable machine")
	r.Set("target", "pectorals")
	if err := app.Save(r); err != nil {
		t.Fatalf("seed: %v", err)
	}

	cands, err := selectCandidates(app, []string{"barbell"}, "")
	if err != nil {
		t.Fatalf("selectCandidates: %v", err)
	}
	for _, c := range cands {
		if c.Equipment != "barbell" {
			t.Fatalf("offered %q which needs %q — user only owns a barbell", c.Name, c.Equipment)
		}
	}
}

// TestGoalRelevanceReordersCandidates is the point of the FTS5 work: the goal
// text must change WHICH exercises the model may choose from, not merely how
// it uses them.
func TestGoalRelevanceReordersCandidates(t *testing.T) {
	app := newTestApp(t)
	seedExercises(t, app, 300)

	t.Setenv("WFC_SEARCH_ENABLED", "1")
	if err := pbbrand.EnsureSearchIndexes(app); err != nil {
		t.Fatalf("build search index: %v", err)
	}

	// Note the goal deliberately contains "for" — a word in no exercise. An
	// AND-joined MATCH returns zero for this input, which is exactly how the
	// first implementation silently did nothing. See ToMatchQueryAny.
	const goal = "shoulder press for delts"

	withGoal, err := selectCandidates(app, []string{"barbell"}, goal)
	if err != nil {
		t.Fatalf("selectCandidates: %v", err)
	}
	noGoal, err := selectCandidates(app, []string{"barbell"}, "")
	if err != nil {
		t.Fatalf("selectCandidates (no goal): %v", err)
	}
	if len(withGoal) == 0 {
		t.Fatal("no candidates")
	}

	// THE LOAD-BEARING ASSERTION: the goal must actually change the result.
	// Without this, every other check here passes even when BM25 contributes
	// nothing, because the diversity spread already puts a deltoid first.
	if sameOrder(withGoal, noGoal) {
		t.Fatalf("the goal made NO difference to candidate selection — "+
			"BM25 retrieval is not running. got %d candidates, identical to the "+
			"no-goal ordering", len(withGoal))
	}

	// The head of the list is the goal-relevant slice: it should be dominated
	// by the muscle group the goal named.
	head := int(promptCandidates * goalRelevantShare)
	if head > len(withGoal) {
		head = len(withGoal)
	}
	delts := 0
	for _, c := range withGoal[:head] {
		if c.Target == "deltoids" {
			delts++
		}
	}
	if delts*2 <= head {
		t.Fatalf("goal named shoulders but only %d of the first %d candidates are "+
			"deltoid work: %v", delts, head, targetsIn(withGoal[:head]))
	}

	// Balance must survive: a plan built only from shoulder work is a bad plan.
	all := targetsIn(withGoal)
	if len(all) < 2 {
		t.Fatalf("goal relevance crowded out every other muscle group: %v", all)
	}
}

func sameOrder(a, b []candidate) bool {
	if len(a) != len(b) {
		return false
	}
	for i := range a {
		if a[i].ID != b[i].ID {
			return false
		}
	}
	return true
}

// TestWorksWithSearchDisabled is the safety property. WFC_SEARCH_ENABLED is
// OFF by default across the fleet, so the AI coach must not depend on it.
func TestWorksWithSearchDisabled(t *testing.T) {
	app := newTestApp(t)
	seedExercises(t, app, 200)

	t.Setenv("WFC_SEARCH_ENABLED", "") // explicitly off — no index exists

	cands, err := selectCandidates(app, []string{"barbell"}, "shoulder press for delts")
	if err != nil {
		t.Fatalf("selectCandidates must not fail when search is off: %v", err)
	}
	if len(cands) == 0 {
		t.Fatal("no candidates with search disabled — the coach is now dependent on FTS5")
	}
	if len(targetsIn(cands)) < 2 {
		t.Fatal("diversity spread did not run in the fallback path")
	}
}

// TestSearchIndexFailureIsNotFatal: enabled, but the index was never built
// (e.g. a boot where reconcile failed). Plans must still generate.
func TestSearchIndexFailureIsNotFatal(t *testing.T) {
	app := newTestApp(t)
	seedExercises(t, app, 100)

	t.Setenv("WFC_SEARCH_ENABLED", "1") // on, but EnsureSearchIndexes NOT called

	cands, err := selectCandidates(app, []string{"barbell"}, "shoulders")
	if err != nil {
		t.Fatalf("a missing search index must not break plan generation: %v", err)
	}
	if len(cands) == 0 {
		t.Fatal("no candidates when the index is missing")
	}
}

// TestNoDuplicateCandidates: the goal-relevant slice and the diversity spread
// draw from the same pool, so they can overlap. A duplicated ex_id wastes
// prompt budget and invites the model to prescribe the same movement twice.
func TestNoDuplicateCandidates(t *testing.T) {
	app := newTestApp(t)
	seedExercises(t, app, 300)

	t.Setenv("WFC_SEARCH_ENABLED", "1")
	if err := pbbrand.EnsureSearchIndexes(app); err != nil {
		t.Fatalf("build search index: %v", err)
	}

	cands, err := selectCandidates(app, []string{"barbell"}, "shoulder press")
	if err != nil {
		t.Fatalf("selectCandidates: %v", err)
	}
	seen := map[string]bool{}
	for _, c := range cands {
		if seen[c.ExID] {
			t.Fatalf("duplicate candidate %s (%s)", c.ExID, c.Name)
		}
		seen[c.ExID] = true
	}
	if len(cands) > promptCandidates {
		t.Fatalf("prompt budget exceeded: %d candidates, cap is %d", len(cands), promptCandidates)
	}
}

// TestHostileGoalText: the goal is free text typed by a user and reaches
// FTS5's MATCH, where a stray quote is a syntax error rather than no results.
func TestHostileGoalText(t *testing.T) {
	app := newTestApp(t)
	seedExercises(t, app, 100)

	t.Setenv("WFC_SEARCH_ENABLED", "1")
	if err := pbbrand.EnsureSearchIndexes(app); err != nil {
		t.Fatalf("build search index: %v", err)
	}

	for _, goal := range []string{
		`"`, `NEAR(`, `a OR`, `'; DROP TABLE exercises; --`, `*`,
		strings.Repeat("shoulders ", 200), "", "   ",
	} {
		cands, err := selectCandidates(app, []string{"barbell"}, goal)
		if err != nil {
			t.Errorf("goal %q errored: %v", goal, err)
			continue
		}
		if len(cands) == 0 {
			t.Errorf("goal %q returned no candidates at all", goal)
		}
	}

	// The table survived the injection attempt.
	if _, err := app.FindCollectionByNameOrId("exercises"); err != nil {
		t.Fatal("exercises collection is gone")
	}
}
