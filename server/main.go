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

	"github.com/pocketbase/pocketbase"
	"github.com/pocketbase/pocketbase/apis"
	"github.com/pocketbase/pocketbase/core"
	"github.com/pocketbase/pocketbase/plugins/migratecmd"

	"webface.cloud/platform/pbbrand"
)

func main() {
	app := pocketbase.New()

	name := os.Getenv("WFC_APP_NAME")
	if name == "" {
		name = "FitBase"
	}
	pbbrand.Bind(app, name)

	migratecmd.MustRegister(app, app.RootCmd, migratecmd.Config{})

	app.OnServe().BindFunc(func(se *core.ServeEvent) error {
		// Phase 0 probe — proves custom routes work end to end. Phase 1 adds
		// /api/ai/plan and /api/ai/progress alongside it.
		se.Router.GET("/api/ai/health", func(e *core.RequestEvent) error {
			return e.JSON(200, map[string]any{"ok": true, "app": name, "ai": os.Getenv("ANTHROPIC_API_KEY") != ""})
		})
		// AI coach: generate a weekly plan from the user's owned equipment.
		se.Router.POST("/api/ai/plan", handleAIPlan(app)).Bind(apis.RequireAuth())
		// AI coach: progression suggestions from logged sessions.
		se.Router.POST("/api/ai/progress", handleAIProgress(app)).Bind(apis.RequireAuth())

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
			return staticHandler(e)
		})
		return se.Next()
	})

	if err := app.Start(); err != nil {
		log.Fatal(err)
	}
}
