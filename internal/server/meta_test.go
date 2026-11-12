package server

import (
	"encoding/json"
	"net/http"
	"strings"
	"testing"

	"mothergoose/internal/store"
)

// escAmp is how encoding/json writes "&" (it escapes it for HTML safety).
const escAmp = `\u0026`

func TestSessionGameTypeAndPageMetaAPI(t *testing.T) {
	f := setup(t)
	// Create with a game type; then change only the game type.
	rec := f.request("POST", "/api/admin/sessions", `{"name":"Crypt","gameType":"Mörk Borg"}`, nil)
	var created store.Session
	json.Unmarshal(rec.Body.Bytes(), &created)
	if rec.Code != 201 || created.GameType != "Mörk Borg" {
		t.Fatalf("create: %d %s", rec.Code, rec.Body.String())
	}
	if rec := f.request("PATCH", "/api/admin/sessions/"+created.ID, `{"gameType":"Pirate Borg"}`, nil); rec.Code != 200 {
		t.Fatalf("patch: %d %s", rec.Code, rec.Body.String())
	}
	got, _ := f.st.GetSession(created.ID)
	if got.Name != "Crypt" || got.GameType != "Pirate Borg" {
		t.Fatalf("after patch: %+v", got.Session)
	}

	// Players see the game type and their pages' details, never the referee's.
	f.request("PATCH", "/api/admin/sessions/"+f.id, `{"gameType":"D&D 5e"}`, nil)
	put := func(scope, file, body string) int {
		return f.request("PUT", "/api/admin/sessions/"+f.id+"/files/"+scope+"/"+file+"/meta", body, nil).Code
	}
	if c := put("shared", "sheet.html", `{"description":"Fill this in first","tags":["character","start here"]}`); c != 200 {
		t.Fatalf("put meta = %d", c)
	}
	put("gm", "secrets.html", `{"description":"The duke is a lich","tags":["spoilers"]}`)
	body := f.do("GET", "/api/active", player).Body.String()
	if !strings.Contains(body, `"gameType":"D`+escAmp+`D 5e"`) || !strings.Contains(body, "Fill this in first") || !strings.Contains(body, "start here") {
		t.Fatalf("player /api/active = %s", body)
	}
	if strings.Contains(body, "lich") || strings.Contains(body, "spoilers") {
		t.Fatalf("referee page details leaked to players: %s", body)
	}

	// Validation and access.
	if c := put("shared", "sheet.html", `{"tags":["a, b"]}`); c != 400 {
		t.Errorf("comma tag = %d", c)
	}
	if c := put("shared", "missing.html", `{}`); c != 404 {
		t.Errorf("missing file = %d", c)
	}
	rec = f.request("PUT", "/api/admin/sessions/"+f.id+"/files/shared/sheet.html/meta", `{}`, func(r *http.Request) { r.RemoteAddr = player })
	if rec.Code != 403 {
		t.Errorf("player editing details = %d", rec.Code)
	}
}
