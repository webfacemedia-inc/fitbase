#!/usr/bin/env python3
"""One-shot backend setup for FitBase: creates the exercises/workouts/sessions
collections, enables the batch API, and seeds the exercise dataset.

Usage:
  PB_SUPERUSER_EMAIL=... PB_SUPERUSER_PASSWORD=... \
  python3 scripts/setup_fitbase.py [path/to/exercises.json]

Get the dataset:
  curl -sL -o exercises.json \
    https://raw.githubusercontent.com/hasaneyldrm/exercises-dataset/main/data/exercises.json
"""
import json, os, sys, urllib.request, urllib.error

BASE = os.environ.get("FITBASE_URL", "https://fitbase.webface.cloud")
DATA = sys.argv[1] if len(sys.argv) > 1 else "exercises.json"
EMAIL = os.environ.get("PB_SUPERUSER_EMAIL")
PASSWORD = os.environ.get("PB_SUPERUSER_PASSWORD")
if not EMAIL or not PASSWORD:
    sys.exit("Set PB_SUPERUSER_EMAIL and PB_SUPERUSER_PASSWORD in the environment.")

def req(method, path, body=None, token=None):
    r = urllib.request.Request(BASE + path, method=method)
    r.add_header("Content-Type", "application/json")
    if token:
        r.add_header("Authorization", token)
    data = json.dumps(body).encode() if body is not None else None
    try:
        with urllib.request.urlopen(r, data=data, timeout=120) as resp:
            return resp.status, json.loads(resp.read() or b"{}")
    except urllib.error.HTTPError as e:
        return e.code, json.loads(e.read() or b"{}")

st, out = req("POST", "/api/collections/_superusers/auth-with-password",
              {"identity": EMAIL, "password": PASSWORD})
if st != 200 or not out.get("token"):
    sys.exit(f"superuser auth failed: {st} {out}")
token = out["token"]
print("auth ok")

st, cols = req("GET", "/api/collections?perPage=200", token=token)
by_name = {c["name"]: c for c in cols.get("items", [])}
users_id = by_name["users"]["id"]

AUTODATES = [
    {"name": "created", "type": "autodate", "onCreate": True},
    {"name": "updated", "type": "autodate", "onCreate": True, "onUpdate": True},
]
OWNER = {"name": "owner", "type": "relation", "required": True,
         "collectionId": users_id, "maxSelect": 1, "cascadeDelete": True}
OWN = "owner = @request.auth.id"
t = lambda n, **kw: {"name": n, "type": "text", **kw}

def ensure_collection(payload):
    name = payload["name"]
    if name in by_name:
        print(f"collection {name}: exists")
        return
    st, out = req("POST", "/api/collections", payload, token=token)
    print(f"collection {name}: {st}" + ("" if st == 200 else f" {out}"))
    if st != 200:
        sys.exit(1)
    by_name[name] = out

ensure_collection({
    "name": "exercises", "type": "base",
    "fields": [t("ex_id", required=True), t("name", required=True), t("category"),
               t("body_part"), t("equipment"), t("target"), t("muscle_group"),
               {"name": "secondary_muscles", "type": "json", "maxSize": 20000},
               {"name": "steps", "type": "json", "maxSize": 200000},
               t("image"), t("gif_url"), t("attribution"), *AUTODATES],
    "indexes": ["CREATE UNIQUE INDEX idx_ex_id ON exercises (ex_id)",
                "CREATE INDEX idx_ex_cat ON exercises (category)",
                "CREATE INDEX idx_ex_eq ON exercises (equipment)"],
    "listRule": "", "viewRule": "",
    "createRule": None, "updateRule": None, "deleteRule": None,
})
ensure_collection({
    "name": "workouts", "type": "base",
    "fields": [t("name", required=True), OWNER,
               {"name": "items", "type": "json", "maxSize": 200000}, *AUTODATES],
    "listRule": OWN, "viewRule": OWN,
    "createRule": '@request.auth.id != "" && ' + OWN,
    "updateRule": OWN, "deleteRule": OWN,
})
ensure_collection({
    "name": "sessions", "type": "base",
    "fields": [OWNER, t("workout_name"),
               {"name": "workout", "type": "relation",
                "collectionId": by_name["workouts"]["id"], "maxSelect": 1,
                "cascadeDelete": False},
               {"name": "entries", "type": "json", "maxSize": 500000},
               t("notes"), *AUTODATES],
    "listRule": OWN, "viewRule": OWN,
    "createRule": '@request.auth.id != "" && ' + OWN,
    "updateRule": OWN, "deleteRule": OWN,
})

st, _ = req("PATCH", "/api/settings",
            {"batch": {"enabled": True, "maxRequests": 300, "timeout": 60,
                       "maxBodySize": 0}}, token=token)
print(f"batch settings: {st}")

st, out = req("GET", "/api/collections/exercises/records?perPage=1", token=token)
existing = out.get("totalItems", 0)
print(f"existing exercise records: {existing}")

data = json.load(open(DATA))
recs = [{
    "ex_id": e["id"], "name": e["name"], "category": e["category"],
    "body_part": e["body_part"], "equipment": e["equipment"], "target": e["target"],
    "muscle_group": e["muscle_group"], "secondary_muscles": e["secondary_muscles"],
    "steps": e["instruction_steps"], "image": e["image"], "gif_url": e["gif_url"],
    "attribution": e["attribution"],
} for e in data]

if existing >= len(recs):
    print("already seeded, nothing to do")
    sys.exit(0)
if existing:
    have, page = set(), 1
    while True:
        st, out = req("GET",
                      f"/api/collections/exercises/records?perPage=500&fields=ex_id&page={page}",
                      token=token)
        items = out.get("items", [])
        have |= {i["ex_id"] for i in items}
        if len(items) < 500:
            break
        page += 1
    recs = [r for r in recs if r["ex_id"] not in have]
    print(f"resuming: {len(recs)} left")

CH = 150
for i in range(0, len(recs), CH):
    chunk = recs[i:i + CH]
    st, out = req("POST", "/api/batch",
                  {"requests": [{"method": "POST",
                                 "url": "/api/collections/exercises/records",
                                 "body": r} for r in chunk]}, token=token)
    if st != 200:
        print(f"batch {i}: FAILED {st} {json.dumps(out)[:400]}")
        sys.exit(1)
    print(f"seeded {min(i + CH, len(recs))}/{len(recs)}")

st, out = req("GET", "/api/collections/exercises/records?perPage=1", token=token)
print(f"DONE — total records: {out.get('totalItems')}")
