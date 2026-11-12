package server

import (
	"bytes"
	"context"
	"image"
	"image/png"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"

	"mothergoose/internal/store"
)

const tinyPDF = "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n"

func pngBytes(t *testing.T) []byte {
	var b bytes.Buffer
	if err := png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 4, 4))); err != nil {
		t.Fatal(err)
	}
	return b.Bytes()
}

func (f *fixture) addFiles(t *testing.T) {
	t.Helper()
	if _, err := f.st.SaveFile(f.id, store.Shared, "map.png", bytes.NewReader(pngBytes(t))); err != nil {
		t.Fatal(err)
	}
	if _, err := f.st.SaveFile(f.id, store.GM, "secret-map.pdf", strings.NewReader(tinyPDF)); err != nil {
		t.Fatal(err)
	}
}

func TestServesPDFsAndImages(t *testing.T) {
	f := setup(t)
	f.addFiles(t)

	rec := f.do("GET", "/s/"+f.id+"/shared/map.png", player)
	if rec.Code != 200 || rec.Header().Get("Content-Type") != "image/png" || rec.Header().Get("X-Content-Type-Options") != "nosniff" {
		t.Fatalf("png: %d %v", rec.Code, rec.Header())
	}
	if strings.Contains(rec.Body.String(), "inject.js") {
		t.Fatal("script injected into an image")
	}

	// Ranges work, which the PDF viewer relies on for big files.
	req := httptest.NewRequest("GET", "/s/"+f.id+"/gm/secret-map.pdf", nil)
	req.Host, req.RemoteAddr = "localhost:8080", host
	req.Header.Set("Range", "bytes=0-7")
	rr := httptest.NewRecorder()
	f.srv.ServeHTTP(rr, req)
	if rr.Code != http.StatusPartialContent || rr.Body.String() != "%PDF-1.4" || rr.Header().Get("Content-Type") != "application/pdf" {
		t.Fatalf("range: %d %q %v", rr.Code, rr.Body.String(), rr.Header())
	}

	// Same access rules as HTML pages.
	if got := f.do("GET", "/s/"+f.id+"/gm/secret-map.pdf", player).Code; got != 403 {
		t.Fatalf("player GM pdf = %d", got)
	}
	f.st.SetActive("")
	if got := f.do("GET", "/s/"+f.id+"/shared/map.png", player).Code; got != 403 {
		t.Fatalf("player image of inactive session = %d", got)
	}
}

func TestStateRoutesRefuseImages(t *testing.T) {
	f := setup(t)
	f.addFiles(t)
	if got := f.do("GET", "/api/admin/sessions/"+f.id+"/files/shared/map.png/export", host).Code; got != 400 {
		t.Errorf("export png = %d", got)
	}
	// PDFs have entries, but are exported filled by the viewer, not here.
	if got := f.do("GET", "/api/admin/sessions/"+f.id+"/files/gm/secret-map.pdf/export", host).Code; got != 400 {
		t.Errorf("export pdf = %d", got)
	}
	if got := f.do("DELETE", "/api/admin/sessions/"+f.id+"/files/gm/secret-map.pdf/state", host).Code; got != 204 {
		t.Errorf("reset pdf = %d", got)
	}
	if got := f.do("DELETE", "/api/admin/sessions/"+f.id+"/files/shared/map.png/state", host).Code; got != 400 {
		t.Errorf("reset png = %d", got)
	}
	ts := httptest.NewServer(f.srv)
	defer ts.Close()
	_, resp, err := websocket.Dial(context.Background(), "ws"+strings.TrimPrefix(ts.URL, "http")+"/ws/file?session="+f.id+"&scope=shared&file=map.png", nil)
	if err == nil || resp == nil || resp.StatusCode != 400 {
		t.Fatalf("ws on png: err=%v resp=%v", err, resp)
	}
}

func TestPDFLiveSync(t *testing.T) {
	f := setup(t)
	f.st.SaveFile(f.id, store.Shared, "form.pdf", strings.NewReader(tinyPDF))
	ts := httptest.NewServer(f.srv)
	defer ts.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws/file?session=" + f.id + "&scope=shared&file=form.pdf"
	a, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer a.CloseNow()
	a.Read(ctx) // snapshot
	a.Write(ctx, websocket.MessageText, []byte(`{"type":"set","key":"pdf:hp","value":"12"}`))
	b, _, err := websocket.Dial(ctx, url, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer b.CloseNow()
	for {
		_, msg, err := b.Read(ctx)
		if err != nil {
			t.Fatal(err)
		}
		if strings.Contains(string(msg), `"pdf:hp":"12"`) {
			break
		}
	}
}

func TestUploadKinds(t *testing.T) {
	f := setup(t)
	var body bytes.Buffer
	mw := multipart.NewWriter(&body)
	mw.WriteField("scope", "shared")
	for name, b := range map[string][]byte{
		"map.png":   pngBytes(t),
		"rules.pdf": []byte(tinyPDF),
		"fake.png":  []byte("<html>not an image"),
	} {
		w, _ := mw.CreateFormFile("files", name)
		w.Write(b)
	}
	mw.Close()
	req := httptest.NewRequest("POST", "/api/admin/sessions/"+f.id+"/files", &body)
	req.Host, req.RemoteAddr = "localhost:8080", host
	req.Header.Set("Content-Type", mw.FormDataContentType())
	rec := httptest.NewRecorder()
	f.srv.ServeHTTP(rec, req)
	if rec.Code != 200 || !strings.Contains(rec.Body.String(), "map.png") || !strings.Contains(rec.Body.String(), "rules.pdf") ||
		!strings.Contains(rec.Body.String(), "isn't a valid PNG") {
		t.Fatalf("upload: %d %s", rec.Code, rec.Body.String())
	}
	if f.st.Exists(f.id, store.Shared, "fake.png") {
		t.Fatal("fake png stored")
	}
}
