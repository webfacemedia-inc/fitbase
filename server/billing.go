package main

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/pocketbase/dbx"
	"github.com/pocketbase/pocketbase/core"
)

func feeBps() int {
	if v, err := strconv.Atoi(os.Getenv("PLATFORM_FEE_BPS")); err == nil && v >= 0 {
		return v
	}
	return 1500 // 15%
}

// stripeForm POSTs a form-encoded request to the Stripe API and returns the
// parsed JSON. The secret key stays server-side (app.env).
func stripeForm(path string, form url.Values) (map[string]any, error) {
	key := os.Getenv("STRIPE_SECRET_KEY")
	if key == "" {
		return nil, fmt.Errorf("billing isn't configured yet")
	}
	req, _ := http.NewRequest("POST", "https://api.stripe.com/v1/"+path, strings.NewReader(form.Encode()))
	req.SetBasicAuth(key, "")
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	resp, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var out map[string]any
	_ = json.Unmarshal(raw, &out)
	if resp.StatusCode != 200 {
		msg := "stripe error"
		if e, ok := out["error"].(map[string]any); ok {
			if m, ok := e["message"].(string); ok {
				msg = m
			}
		}
		return out, fmt.Errorf("%s", msg)
	}
	return out, nil
}

// POST /api/billing/connect — coach onboarding. Creates (or reuses) an Express
// connected account and returns a Stripe-hosted onboarding link.
func handleBillingConnect(app core.App) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		if e.Auth == nil {
			return e.UnauthorizedError("sign in first", nil)
		}
		u := e.Auth
		acct := u.GetString("stripe_account_id")
		if acct == "" {
			f := url.Values{}
			f.Set("type", "express")
			f.Set("country", "CA")
			f.Set("capabilities[card_payments][requested]", "true")
			f.Set("capabilities[transfers][requested]", "true")
			f.Set("business_type", "individual")
			f.Set("metadata[user]", u.Id)
			out, err := stripeForm("accounts", f)
			if err != nil {
				return e.InternalServerError("could not start onboarding: "+err.Error(), err)
			}
			acct, _ = out["id"].(string)
			u.Set("stripe_account_id", acct)
			if err := app.Save(u); err != nil {
				return e.InternalServerError("could not save account", err)
			}
		}
		base := appBaseURL(app)
		lf := url.Values{}
		lf.Set("account", acct)
		lf.Set("refresh_url", base+"/#/coach")
		lf.Set("return_url", base+"/#/coach")
		lf.Set("type", "account_onboarding")
		link, err := stripeForm("account_links", lf)
		if err != nil {
			return e.InternalServerError("could not create onboarding link: "+err.Error(), err)
		}
		return e.JSON(200, map[string]any{"url": link["url"]})
	}
}

// GET /api/billing/status — coach's payout readiness.
func handleBillingStatus(app core.App) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		if e.Auth == nil {
			return e.UnauthorizedError("sign in first", nil)
		}
		return e.JSON(200, map[string]any{
			"onboarded":     e.Auth.GetString("stripe_account_id") != "",
			"payouts_ready": e.Auth.GetBool("payouts_ready"),
		})
	}
}

// POST /api/billing/hire {service_id} — a client hires a coach's service. Creates
// a Checkout Session with the platform fee retained and funds routed to the coach.
func handleBillingHire(app core.App) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		if e.Auth == nil {
			return e.UnauthorizedError("sign in first", nil)
		}
		var body struct {
			ServiceID string `json:"service_id"`
		}
		if err := e.BindBody(&body); err != nil || body.ServiceID == "" {
			return e.BadRequestError("service_id required", nil)
		}
		svc, err := app.FindRecordById("services", body.ServiceID)
		if err != nil || !svc.GetBool("active") {
			return e.NotFoundError("service not available", nil)
		}
		coach, err := app.FindRecordById("users", svc.GetString("coach"))
		if err != nil {
			return e.NotFoundError("coach not found", nil)
		}
		if coach.Id == e.Auth.Id {
			return e.BadRequestError("You can't hire your own service.", nil)
		}
		if !coach.GetBool("payouts_ready") {
			return e.BadRequestError("This coach hasn't finished setting up payouts yet.", nil)
		}
		acct := coach.GetString("stripe_account_id")
		rate := svc.GetInt("rate")
		if rate < 1 {
			return e.BadRequestError("invalid service price", nil)
		}
		fee := rate * feeBps() / 10000
		base := appBaseURL(app)

		f := url.Values{}
		f.Set("success_url", base+"/#/coaches?hired=1")
		f.Set("cancel_url", base+"/#/coaches")
		f.Set("client_reference_id", e.Auth.Id)
		f.Set("metadata[service_id]", svc.Id)
		f.Set("metadata[coach]", coach.Id)
		f.Set("metadata[client]", e.Auth.Id)
		f.Set("line_items[0][quantity]", "1")
		f.Set("line_items[0][price_data][currency]", "cad")
		f.Set("line_items[0][price_data][product_data][name]", svc.GetString("title"))
		f.Set("line_items[0][price_data][unit_amount]", strconv.Itoa(rate))

		if svc.GetString("cadence") == "monthly" {
			f.Set("mode", "subscription")
			f.Set("line_items[0][price_data][recurring][interval]", "month")
			f.Set("subscription_data[application_fee_percent]", strconv.FormatFloat(float64(feeBps())/100, 'f', -1, 64))
			f.Set("subscription_data[transfer_data][destination]", acct)
		} else {
			f.Set("mode", "payment")
			f.Set("payment_intent_data[application_fee_amount]", strconv.Itoa(fee))
			f.Set("payment_intent_data[transfer_data][destination]", acct)
		}
		sess, err := stripeForm("checkout/sessions", f)
		if err != nil {
			return e.InternalServerError("could not start checkout: "+err.Error(), err)
		}
		return e.JSON(200, map[string]any{"url": sess["url"]})
	}
}

// POST /hooks/stripe — Stripe webhook. Verifies the signature, then updates
// payout readiness and, on a completed checkout, links the client to the coach.
func handleStripeWebhook(app core.App) func(*core.RequestEvent) error {
	return func(e *core.RequestEvent) error {
		payload, err := io.ReadAll(e.Request.Body)
		if err != nil {
			return e.BadRequestError("no body", nil)
		}
		secret := os.Getenv("STRIPE_WEBHOOK_SECRET")
		if !verifyStripeSig(payload, e.Request.Header.Get("Stripe-Signature"), secret) {
			return e.UnauthorizedError("bad signature", nil)
		}
		var evt struct {
			Type string `json:"type"`
			Data struct {
				Object map[string]any `json:"object"`
			} `json:"data"`
		}
		if err := json.Unmarshal(payload, &evt); err != nil {
			return e.BadRequestError("bad event", nil)
		}
		obj := evt.Data.Object

		switch evt.Type {
		case "account.updated":
			id, _ := obj["id"].(string)
			charges, _ := obj["charges_enabled"].(bool)
			payouts, _ := obj["payouts_enabled"].(bool)
			if u, err := app.FindFirstRecordByFilter("users", "stripe_account_id = {:a}", dbx.Params{"a": id}); err == nil {
				u.Set("payouts_ready", charges && payouts)
				_ = app.Save(u)
			}
		case "checkout.session.completed":
			md, _ := obj["metadata"].(map[string]any)
			coachID, _ := md["coach"].(string)
			clientID, _ := md["client"].(string)
			svcID, _ := md["service"].(string)
			if svcID == "" {
				svcID, _ = md["service_id"].(string)
			}
			sessID, _ := obj["id"].(string)
			subID, _ := obj["subscription"].(string)
			if coachID != "" && clientID != "" {
				linkEngagement(app, coachID, clientID, svcID, sessID, subID)
			}
		case "customer.subscription.deleted":
			subID, _ := obj["id"].(string)
			if eng, err := app.FindFirstRecordByFilter("engagements", "stripe_subscription = {:s}", dbx.Params{"s": subID}); err == nil {
				eng.Set("status", "canceled")
				_ = app.Save(eng)
				// revoke the coach link + drop the client back to free
				if m, err := app.FindFirstRecordByFilter("memberships",
					"coach = {:c} && client = {:u}", dbx.Params{"c": eng.GetString("coach"), "u": eng.GetString("client")}); err == nil {
					m.Set("status", "revoked")
					_ = app.Save(m)
				}
				if u, err := app.FindRecordById("users", eng.GetString("client")); err == nil {
					u.Set("plan", "free")
					_ = app.Save(u)
				}
			}
		}
		return e.JSON(200, map[string]any{"received": true})
	}
}

func linkEngagement(app core.App, coachID, clientID, svcID, sessID, subID string) {
	ecol, err := app.FindCollectionByNameOrId("engagements")
	if err != nil {
		return
	}
	eng := core.NewRecord(ecol)
	eng.Set("coach", coachID)
	eng.Set("client", clientID)
	if svcID != "" {
		eng.Set("service", svcID)
	}
	eng.Set("status", "active")
	eng.Set("stripe_session", sessID)
	if subID != "" {
		eng.Set("stripe_subscription", subID)
	}
	_ = app.Save(eng)

	// activate the coach↔client membership so the coach gains access
	mcol, _ := app.FindCollectionByNameOrId("memberships")
	m, _ := app.FindFirstRecordByFilter("memberships",
		"coach = {:c} && client = {:u}", dbx.Params{"c": coachID, "u": clientID})
	if m == nil {
		m = core.NewRecord(mcol)
		m.Set("coach", coachID)
		m.Set("client", clientID)
	}
	m.Set("status", "active")
	_ = app.Save(m)

	// mark the client as paid
	if u, err := app.FindRecordById("users", clientID); err == nil {
		u.Set("plan", "paid")
		_ = app.Save(u)
	}
}

func verifyStripeSig(payload []byte, header, secret string) bool {
	if secret == "" || header == "" {
		return false
	}
	var t string
	var v1 []string
	for _, part := range strings.Split(header, ",") {
		kv := strings.SplitN(part, "=", 2)
		if len(kv) != 2 {
			continue
		}
		switch kv[0] {
		case "t":
			t = kv[1]
		case "v1":
			v1 = append(v1, kv[1])
		}
	}
	if t == "" || len(v1) == 0 {
		return false
	}
	ts, err := strconv.ParseInt(t, 10, 64)
	if err != nil || absInt64(time.Now().Unix()-ts) > 300 {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write([]byte(t + "." + string(payload)))
	expected := hex.EncodeToString(mac.Sum(nil))
	for _, v := range v1 {
		if hmac.Equal([]byte(v), []byte(expected)) {
			return true
		}
	}
	return false
}

func absInt64(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}
