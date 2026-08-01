package main

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"net/mail"
	"os"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/tools/mailer"
)

// ensureSchema self-heals collection shape on boot so the marketplace can show
// a coach's display name publicly (the users collection view rule hides `name`
// from non-owners, so the public `services` list can't expand it). We denormalize
// a public `coach_name` onto services and backfill it. Idempotent.
func ensureSchema(app core.App) {
	col, err := app.FindCollectionByNameOrId("services")
	if err != nil {
		return
	}
	if col.Fields.GetByName("coach_name") == nil {
		col.Fields.Add(&core.TextField{Name: "coach_name"})
		if err := app.Save(col); err != nil {
			app.Logger().Warn("ensureSchema: add coach_name failed", "err", err)
			return
		}
	}
	recs, err := app.FindAllRecords("services")
	if err != nil {
		return
	}
	for _, r := range recs {
		if r.GetString("coach_name") != "" {
			continue
		}
		u, err := app.FindRecordById("users", r.GetString("coach"))
		if err != nil {
			continue
		}
		nm := u.GetString("name")
		if nm == "" {
			nm = u.GetString("email")
		}
		r.Set("coach_name", nm)
		_ = app.Save(r)
	}
}

func randToken() string {
	b := make([]byte, 20)
	_, _ = rand.Read(b)
	return hex.EncodeToString(b)
}

func appBaseURL(app core.App) string {
	if v := os.Getenv("WFC_APP_URL"); v != "" {
		return strings.TrimRight(v, "/")
	}
	if u := app.Settings().Meta.AppURL; u != "" {
		return strings.TrimRight(u, "/")
	}
	return "https://fitbase.webface.cloud"
}

func displayName(u *core.Record) string {
	if n := strings.TrimSpace(u.GetString("name")); n != "" {
		return n
	}
	return u.Email()
}

// POST /api/invite {email, role} — a coach invites someone by email. Mints a
// single-use token, stores the invite, and emails an accept link.
func handleInviteCreate(app core.App) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		if e.Auth == nil {
			return e.UnauthorizedError("sign in first", nil)
		}
		var body struct {
			Email string `json:"email"`
			Role  string `json:"role"`
		}
		if err := e.BindBody(&body); err != nil || strings.TrimSpace(body.Email) == "" {
			return e.BadRequestError("email required", nil)
		}
		email := strings.ToLower(strings.TrimSpace(body.Email))
		role := body.Role
		if role != "coach" {
			role = "client"
		}
		col, err := app.FindCollectionByNameOrId("invites")
		if err != nil {
			return e.InternalServerError("invites collection missing", err)
		}
		token := randToken()
		rec := core.NewRecord(col)
		rec.Set("token", token)
		rec.Set("coach", e.Auth.Id)
		rec.Set("email", email)
		rec.Set("role", role)
		rec.Set("status", "pending")
		rec.Set("expires", time.Now().AddDate(0, 0, 7))
		if err := app.Save(rec); err != nil {
			return e.InternalServerError("could not create invite", err)
		}

		link := appBaseURL(app) + "/#/accept/" + token
		coach := displayName(e.Auth)
		html := fmt.Sprintf(
			"<p>%s invited you to train together on <b>FitBase</b>.</p>"+
				"<p>As their %s, you'll share a plan and progress. Accept your invite:</p>"+
				"<p><a href=\"%s\">Accept invite</a></p>"+
				"<p style=\"color:#888;font-size:12px\">This link is single-use and expires in 7 days. "+
				"If you didn't expect this, ignore it.</p>",
			htmlEsc(coach), role, link)
		sender := app.Settings().Meta.SenderAddress
		if sender == "" {
			sender = "mail@webfacemedia.com"
		}
		msg := &mailer.Message{
			From:    mail.Address{Name: app.Settings().Meta.SenderName, Address: sender},
			To:      []mail.Address{{Address: email}},
			Subject: coach + " invited you to FitBase",
			HTML:    html,
		}
		if err := app.NewMailClient().Send(msg); err != nil {
			// invite is stored; surface the mail failure but keep the token usable
			return e.JSON(200, map[string]any{"ok": true, "emailed": false, "token": token, "link": link})
		}
		return e.JSON(200, map[string]any{"ok": true, "emailed": true})
	}
}

// GET /api/invite/{token} — public: details for the accept page.
func handleInviteInfo(app core.App) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		token := e.Request.PathValue("token")
		inv, err := app.FindFirstRecordByFilter("invites", "token = {:t}", dbx.Params{"t": token})
		if err != nil {
			return e.NotFoundError("invite not found", nil)
		}
		coach, _ := app.FindRecordById("users", inv.GetString("coach"))
		status := inv.GetString("status")
		if status == "pending" && inv.GetDateTime("expires").Time().Before(time.Now()) {
			status = "expired"
		}
		name := ""
		if coach != nil {
			name = displayName(coach)
		}
		return e.JSON(200, map[string]any{
			"coach": name, "role": inv.GetString("role"), "status": status,
			"email": inv.GetString("email"),
		})
	}
}

// POST /api/invite/accept {token} — the signed-in invitee accepts. Single-use:
// creates the active membership and marks the invite accepted.
func handleInviteAccept(app core.App) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		if e.Auth == nil {
			return e.UnauthorizedError("sign in first", nil)
		}
		var body struct {
			Token string `json:"token"`
		}
		if err := e.BindBody(&body); err != nil || body.Token == "" {
			return e.BadRequestError("token required", nil)
		}
		inv, err := app.FindFirstRecordByFilter("invites", "token = {:t}", dbx.Params{"t": body.Token})
		if err != nil {
			return e.NotFoundError("invite not found", nil)
		}
		if inv.GetString("status") != "pending" {
			return e.BadRequestError("This invite has already been used or revoked.", nil)
		}
		if inv.GetDateTime("expires").Time().Before(time.Now()) {
			inv.Set("status", "expired")
			_ = app.Save(inv)
			return e.BadRequestError("This invite has expired.", nil)
		}
		coachID := inv.GetString("coach")
		clientID := e.Auth.Id
		if coachID == clientID {
			return e.BadRequestError("You can't accept your own invite.", nil)
		}

		// upsert membership (coach + client), set active
		mcol, err := app.FindCollectionByNameOrId("memberships")
		if err != nil {
			return e.InternalServerError("memberships collection missing", err)
		}
		m, _ := app.FindFirstRecordByFilter("memberships",
			"coach = {:c} && client = {:u}", dbx.Params{"c": coachID, "u": clientID})
		if m == nil {
			m = core.NewRecord(mcol)
			m.Set("coach", coachID)
			m.Set("client", clientID)
		}
		m.Set("status", "active")
		if err := app.Save(m); err != nil {
			return e.InternalServerError("could not link accounts", err)
		}
		inv.Set("status", "accepted")
		_ = app.Save(inv)
		return e.JSON(200, map[string]any{"ok": true, "coach": coachID})
	}
}

func htmlEsc(s string) string {
	r := strings.NewReplacer("&", "&amp;", "<", "&lt;", ">", "&gt;", "\"", "&quot;")
	return r.Replace(s)
}
