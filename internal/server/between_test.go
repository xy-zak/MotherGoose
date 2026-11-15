package server

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"io"
	"sort"
	"strings"
	"testing"

	"mothergoose/internal/store"
)

// Deleting answers with a trash id that puts the page back; the trash is
// host-only.
func TestTrashRoutes(t *testing.T) {
	f := setup(t)
	f.st.SetValue(f.id, store.Shared, "sheet.html", "", "#notes", json.RawMessage(`"kept"`))
	rec := f.request("DELETE", "/api/admin/sessions/"+f.id+"/files/shared/sheet.html", "", nil)
	var del struct{ Trash string }
	json.Unmarshal(rec.Body.Bytes(), &del)
	if rec.Code != 200 || del.Trash == "" {
		t.Fatalf("delete: %d %s", rec.Code, rec.Body.String())
	}
	if got := f.do("GET", "/api/admin/trash", player).Code; got != 403 {
		t.Errorf("trash from a player's device: %d", got)
	}
	if got := f.do("POST", "/api/admin/trash/"+del.Trash+"/restore", player).Code; got != 403 {
		t.Errorf("restore from a player's device: %d", got)
	}
	rec = f.request("GET", "/api/admin/trash", "", nil)
	if !strings.Contains(rec.Body.String(), `"name":"sheet.html"`) || !strings.Contains(rec.Body.String(), `"keepDays":30`) {
		t.Fatalf("list: %s", rec.Body.String())
	}
	rec = f.request("POST", "/api/admin/trash/"+del.Trash+"/restore", "", nil)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), `"name":"sheet.html"`) {
		t.Fatalf("restore: %d %s", rec.Code, rec.Body.String())
	}
	if st, _ := f.st.GetState(f.id, store.Shared, "sheet.html", ""); string(st["#notes"]) != `"kept"` {
		t.Fatalf("entries after restore: %v", st)
	}
	if rec := f.request("POST", "/api/admin/trash/"+del.Trash+"/restore", "", nil); rec.Code != 404 {
		t.Errorf("restore twice: %d", rec.Code)
	}
	// Clearing entries answers with a trash id too, and emptying forgets it.
	rec = f.request("DELETE", "/api/admin/sessions/"+f.id+"/files/shared/sheet.html/state", "", nil)
	if !strings.Contains(rec.Body.String(), `"trash":"2`) {
		t.Fatalf("clear: %s", rec.Body.String())
	}
	if rec := f.request("DELETE", "/api/admin/trash", "", nil); rec.Code != 204 {
		t.Fatalf("empty: %d", rec.Code)
	}
	if rec := f.request("GET", "/api/admin/trash", "", nil); !strings.Contains(rec.Body.String(), `"items":[]`) {
		t.Fatalf("after emptying: %s", rec.Body.String())
	}
}

func TestDuplicateRoute(t *testing.T) {
	f := setup(t)
	f.st.AddPlayer(f.id, "Ana")
	rec := f.request("POST", "/api/admin/sessions/"+f.id+"/duplicate", `{"name":"Night Market II"}`, nil)
	if rec.Code != 201 || !strings.Contains(rec.Body.String(), `"id":"night-market-ii"`) {
		t.Fatalf("duplicate: %d %s", rec.Code, rec.Body.String())
	}
	sum, _ := f.st.GetSession("night-market-ii")
	if len(sum.Players) != 0 || len(sum.Files[store.Shared]) != 1 || len(sum.Files[store.GM]) != 1 || sum.Active {
		t.Fatalf("copy: %+v", sum)
	}
	if rec := f.request("POST", "/api/admin/sessions/nope/duplicate", `{"name":"X"}`, nil); rec.Code != 404 {
		t.Errorf("missing campaign: %d", rec.Code)
	}
}

// Export all: every page filled in, each player's copy beside a per-player
// page, PDFs as themselves plus their entries.
func TestExportAllZip(t *testing.T) {
	f := setup(t)
	f.st.AddPlayer(f.id, "Ana")
	on := true
	f.st.UpdatePageMeta(f.id, store.Shared, "sheet.html", store.PageUpdate{PerPlayer: &on})
	f.st.SetValue(f.id, store.Shared, "sheet.html", "ana", "#notes", json.RawMessage(`"Ana's notes"`))
	f.st.SaveFile(f.id, store.GM, "rules.pdf", strings.NewReader("%PDF-1.4\n%%EOF\n"))
	f.st.SetValue(f.id, store.GM, "rules.pdf", "", "hp", json.RawMessage(`"12"`))
	f.st.SaveFile(f.id, store.Shared, "map.png", bytes.NewReader([]byte("\x89PNG\r\n\x1a\n0000")))
	rec := f.request("GET", "/api/admin/sessions/"+f.id+"/export.zip", "", nil)
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "application/zip" {
		t.Fatalf("export: %d %s", rec.Code, rec.Header())
	}
	z, err := zip.NewReader(bytes.NewReader(rec.Body.Bytes()), int64(rec.Body.Len()))
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{}
	names := []string{}
	for _, zf := range z.File {
		r, _ := zf.Open()
		b, _ := io.ReadAll(r)
		files[zf.Name] = string(b)
		names = append(names, zf.Name)
	}
	sort.Strings(names)
	want := "players/map.png players/sheet-ana-filled.html players/sheet-filled.html referee/rules.entries.json referee/rules.pdf referee/secrets-filled.html"
	if got := strings.Join(names, " "); got != want {
		t.Fatalf("zip holds:\n %s\nwant\n %s", got, want)
	}
	if !strings.Contains(files["players/sheet-ana-filled.html"], `Ana's notes`) || strings.Contains(files["players/sheet-filled.html"], `Ana's notes`) {
		t.Error("copies mixed up")
	}
	if !strings.Contains(files["referee/rules.entries.json"], `"12"`) {
		t.Errorf("pdf entries: %s", files["referee/rules.entries.json"])
	}
	if got := f.do("GET", "/api/admin/sessions/"+f.id+"/export.zip", player).Code; got != 403 {
		t.Errorf("export from a player's device: %d", got)
	}
}
