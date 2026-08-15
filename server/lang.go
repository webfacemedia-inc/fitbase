package main

import (
	"github.com/pocketbase/pocketbase/core"
)

// The steps/AI language codes the product supports (mirrors LANGS in app.js).
var validLangs = map[string]bool{
	"en": true, "es": true, "it": true, "tr": true, "ru": true,
	"zh": true, "hi": true, "pl": true, "ko": true, "fr": true,
}

// English names for the AI prompt instruction (en needs none).
var langNames = map[string]string{
	"es": "Spanish", "it": "Italian", "tr": "Turkish", "ru": "Russian",
	"zh": "Chinese", "hi": "Hindi", "pl": "Polish", "ko": "Korean", "fr": "French",
}

// ensureUserLang self-heals the users collection for the language preference:
// adds the `lang` field if missing, and — only when the collection has no
// update rule at all (admin-only) — opens self-update with the standard
// `id = @request.auth.id`. A custom rule is never overwritten, just logged.
// Idempotent; safe to run on every boot. The escalation guard that makes
// self-update safe lives in guardUserSelfUpdate below.
func ensureUserLang(app core.App) {
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		return
	}
	changed := false
	if users.Fields.GetByName("lang") == nil {
		users.Fields.Add(&core.TextField{Name: "lang", Max: 8})
		changed = true
	}
	if users.UpdateRule == nil {
		rule := "id = @request.auth.id"
		users.UpdateRule = &rule
		changed = true
	} else {
		app.Logger().Info("ensureUserLang: users updateRule already set", "rule", *users.UpdateRule)
	}
	if changed {
		if err := app.Save(users); err != nil {
			app.Logger().Warn("ensureUserLang: save users collection failed", "err", err)
		}
	}
}

// guardUserSelfUpdate keeps user self-updates to safe fields. Without it,
// opening the update rule for `lang` would also let a user PATCH plan:"paid"
// and get the paid AI model for free (resolvePlan trusts users.plan). The
// Stripe webhook writes plan via internal app.Save, which does not fire
// request hooks, so billing is unaffected.
func guardUserSelfUpdate(app core.App) {
	app.OnRecordUpdateRequest("users").BindFunc(func(e *core.RecordRequestEvent) error {
		if e.HasSuperuserAuth() {
			return e.Next()
		}
		e.Record.Set("plan", e.Record.Original().GetString("plan"))
		if l := e.Record.GetString("lang"); l != "" && !validLangs[l] {
			e.Record.Set("lang", e.Record.Original().GetString("lang"))
		}
		return e.Next()
	})
}

// langInstruction returns the AI-prompt suffix asking for responses in the
// user's preferred language. Empty for English, unset, or junk values. The
// ex_id pinning matters: plan resolution is keyed on exact ex_id matches.
func langInstruction(u *core.Record) string {
	name, ok := langNames[u.GetString("lang")]
	if !ok {
		return ""
	}
	return " Respond in " + name + ": write every prose field (names, labels, rationale, notes) in " +
		name + ". Copy every ex_id exactly as given — never translate, transliterate, or alter " +
		"ex_id values or the exercise names in the candidate list."
}
