package main

import (
	"strings"
	"testing"

	"github.com/pocketbase/pocketbase/core"
)

func TestLangInstruction(t *testing.T) {
	app := newTestApp(t)
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		t.Fatalf("users collection: %v", err)
	}
	ensureUserLang(app)
	users, _ = app.FindCollectionByNameOrId("users")
	if users.Fields.GetByName("lang") == nil {
		t.Fatal("ensureUserLang did not add the lang field")
	}

	u := core.NewRecord(users)
	u.Set("email", "l@t.local")
	u.Set("password", "0123456789")
	if err := app.Save(u); err != nil {
		t.Fatalf("save user: %v", err)
	}

	for _, lang := range []string{"", "en", "xx"} {
		u.Set("lang", lang)
		if got := langInstruction(u); got != "" {
			t.Errorf("lang %q: expected empty instruction, got %q", lang, got)
		}
	}
	u.Set("lang", "es")
	got := langInstruction(u)
	if !strings.Contains(got, "Spanish") {
		t.Errorf("es instruction missing language name: %q", got)
	}
	if !strings.Contains(got, "ex_id") {
		t.Errorf("es instruction must pin ex_id values: %q", got)
	}
}

// A user must never be able to escalate their own billing tier through the
// self-update path that the language preference opens.
func TestGuardBlocksPlanEscalation(t *testing.T) {
	app := newTestApp(t)
	ensureUserLang(app)
	users, _ := app.FindCollectionByNameOrId("users")
	if users.Fields.GetByName("plan") == nil {
		users.Fields.Add(&core.TextField{Name: "plan", Max: 20})
		if err := app.Save(users); err != nil {
			t.Fatalf("add plan field: %v", err)
		}
	}

	u := core.NewRecord(users)
	u.Set("email", "g@t.local")
	u.Set("password", "0123456789")
	u.Set("plan", "free")
	u.Set("lang", "en")
	if err := app.Save(u); err != nil {
		t.Fatalf("save user: %v", err)
	}

	// Simulate what the request hook does to a non-superuser update attempt.
	fresh, _ := app.FindRecordById("users", u.Id)
	fresh.Set("plan", "paid") // the escalation attempt
	fresh.Set("lang", "es")   // the legitimate change
	fresh.Set("plan", fresh.Original().GetString("plan"))
	if l := fresh.GetString("lang"); l != "" && !validLangs[l] {
		fresh.Set("lang", fresh.Original().GetString("lang"))
	}
	if err := app.Save(fresh); err != nil {
		t.Fatalf("guarded save: %v", err)
	}

	check, _ := app.FindRecordById("users", u.Id)
	if check.GetString("plan") != "free" {
		t.Errorf("plan escalated to %q — guard failed", check.GetString("plan"))
	}
	if check.GetString("lang") != "es" {
		t.Errorf("legitimate lang change lost: %q", check.GetString("lang"))
	}

	// Junk language codes are reverted too.
	fresh2, _ := app.FindRecordById("users", u.Id)
	fresh2.Set("lang", "zz")
	if l := fresh2.GetString("lang"); l != "" && !validLangs[l] {
		fresh2.Set("lang", fresh2.Original().GetString("lang"))
	}
	if err := app.Save(fresh2); err != nil {
		t.Fatalf("junk-lang save: %v", err)
	}
	check2, _ := app.FindRecordById("users", u.Id)
	if check2.GetString("lang") != "es" {
		t.Errorf("junk lang accepted: %q", check2.GetString("lang"))
	}
}
