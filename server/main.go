// FitBase custom backend binary (runs on webface.cloud via the generic `custom`
// template). Branded PocketBase (pbbrand: admin brand + SMTP/appURL env
// fallbacks + row retention) that serves the buildless SPA from pb_public and
// owns the server-side routes the product needs — starting with the AI coach
// (/api/ai/*), where the Anthropic key stays in app.env and never reaches the
// browser. The frontend still deploys separately via git into pb_public; this
// binary owns only the backend logic.
package main

import (
	"log"
	"os"
	"path/filepath"
	"strings"

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"

	"webface.cloud/platform/pbbrand"
)

// cleanRoutes maps short public paths to their SPA hash routes.
var cleanRoutes = map[string]string{
	"/demo":    "/#/demo",
	"/library": "/#/library",
	"/signin":  "/#/signin",
	"/signup":  "/#/signin",
	"/coaches": "/#/coaches",
	"/app":     "/#/workouts",
}

func main() {
	app := pocketbase.New()

	name := os.Getenv("WFC_APP_NAME")
	if name == "" {
		name = "FitBase"
	}
	pbbrand.Bind(app, name)

	migratecmd.MustRegister(app, app.RootCmd, migratecmd.Config{})

	// Users may self-update (language preference), but never their billing tier.
	guardUserSelfUpdate(app)

	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		ensureSchema(app)   // self-heal: coach_name on services (+ backfill)
		ensureOAuth(app)    // Google sign-in from app.env (GOOGLE_CLIENT_ID/SECRET)
		ensureUserLang(app) // users.lang field + self-update rule (guarded below)

		// Phase 0 probe — proves custom routes work end to end. Phase 1 adds
		// /api/ai/plan and /api/ai/progress alongside it.
		se.Router.GET("/api/ai/health", func(e *core.RequestEvent) error {
			return e.JSON(200, map[string]any{"ok": true, "app": name, "ai": os.Getenv("ANTHROPIC_API_KEY") != ""})
		})
		// AI coach: generate a weekly plan from the user's owned equipment.
		se.Router.POST("/api/ai/plan", handleAIPlan(app)).Bind(apis.RequireAuth())
		// AI coach: progression suggestions from logged sessions.
		se.Router.POST("/api/ai/progress", handleAIProgress(app)).Bind(apis.RequireAuth())

		// Coach marketplace: invites (create + accept) and public invite lookup.
		se.Router.POST("/api/invite", handleInviteCreate(app)).Bind(apis.RequireAuth())
		se.Router.POST("/api/invite/accept", handleInviteAccept(app)).Bind(apis.RequireAuth())
		se.Router.GET("/api/invite/{token}", handleInviteInfo(app))

		// Marketplace billing (Stripe Connect).
		se.Router.POST("/api/billing/connect", handleBillingConnect(app)).Bind(apis.RequireAuth())
		se.Router.GET("/api/billing/status", handleBillingStatus(app)).Bind(apis.RequireAuth())
		se.Router.GET("/api/billing/hireable", handleBillingHireable(app)) // public, cached
		se.Router.POST("/api/billing/hire", handleBillingHire(app)).Bind(apis.RequireAuth())
		se.Router.POST("/hooks/stripe", handleStripeWebhook(app)) // Stripe-signed, no auth

		// Smart static root: serve the SPA from pb_public with SPA fallback when
		// index.html is present (checked per request, so a git deploy needs no
		// restart); otherwise 302 to the admin. Identical to the stock binary so
		// switching templates is behaviourally transparent.
		pubDir, _ := filepath.Abs("pb_public") // unit sets WorkingDirectory to the app dir
		staticHandler := apis.Static(os.DirFS(pubDir), true)
		se.Router.GET("/{path...}", func(e *core.RequestEvent) error {
			if _, err := os.Stat(filepath.Join(pubDir, "index.html")); err != nil {
				if e.Request.URL.Path == "/" {
					return e.Redirect(302, "/_/")
				}
				return e.NotFoundError("", nil)
			}
			// Cache policy: without explicit headers browsers heuristically cache
			// HTML, so a deploy doesn't show until a hard refresh. HTML (and
			// extensionless SPA/legal routes) must always revalidate; versioned
			// vendor files are immutable; other assets are ?v=-busted per deploy.
			p := e.Request.URL.Path
			// Clean, shareable URLs for links that go in emails and messages — a
			// hash route is not something you paste into a note to a gym owner.
			if dest, ok := cleanRoutes[strings.TrimSuffix(p, "/")]; ok && p != "/" {
				return e.Redirect(302, dest)
			}
			h := e.Response.Header()
			switch {
			case strings.HasPrefix(p, "/vendor/"):
				h.Set("Cache-Control", "public, max-age=31536000, immutable")
			case strings.HasSuffix(p, ".html") || filepath.Ext(p) == "":
				h.Set("Cache-Control", "no-cache")
			default:
				h.Set("Cache-Control", "public, max-age=86400")
			}
			return staticHandler(e)
		})
		return se.Next()
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}
