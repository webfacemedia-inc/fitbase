package main

import (
	"os"

	"github.com/pocketbase/pocketbase/core"
)

// ensureOAuth wires Google sign-in into the users collection from app.env
// (GOOGLE_CLIENT_ID / GOOGLE_CLIENT_SECRET) on boot — same posture as the
// Anthropic key: the secret lives only on the droplet, never in the repo or
// the admin UI by hand. Idempotent; env values win over any stale stored
// config; a no-op when the env vars are absent (the SPA then simply doesn't
// show the Google button, because listAuthMethods reports no providers).
func ensureOAuth(app core.App) {
	id, secret := os.Getenv("GOOGLE_CLIENT_ID"), os.Getenv("GOOGLE_CLIENT_SECRET")
	if id == "" || secret == "" {
		return
	}
	users, err := app.FindCollectionByNameOrId("users")
	if err != nil {
		return
	}
	prov := core.OAuth2ProviderConfig{Name: "google", ClientId: id, ClientSecret: secret}
	replaced := false
	for i := range users.OAuth2.Providers {
		if users.OAuth2.Providers[i].Name == "google" {
			if users.OAuth2.Enabled &&
				users.OAuth2.Providers[i].ClientId == id &&
				users.OAuth2.Providers[i].ClientSecret == secret {
				return // already correct — skip the save
			}
			users.OAuth2.Providers[i] = prov
			replaced = true
			break
		}
	}
	if !replaced {
		users.OAuth2.Providers = append(users.OAuth2.Providers, prov)
	}
	users.OAuth2.Enabled = true
	if err := app.Save(users); err != nil {
		app.Logger().Warn("ensureOAuth: save users oauth2 config failed", "err", err)
	}
}
