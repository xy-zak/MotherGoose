// The API for sessions: listing, creating, editing, going live and ending.
package server

import (
	"fmt"
	"net/http"

	qrcode "github.com/skip2/go-qrcode"

	"mothergoose/internal/store"
)

func (s *Server) apiActive(w http.ResponseWriter, r *http.Request) {
	host := s.isHost(r)
	resp := map[string]any{"isHost": host, "session": nil, "files": []store.FileInfo{}, "players": []store.Player{}, "me": nil}
	if id := s.store.Active(); id != "" {
		if sum, err := s.store.GetSession(id); err == nil {
			resp["session"] = map[string]string{"id": sum.ID, "name": sum.Name, "gameType": sum.GameType}
			files := append([]store.FileInfo{}, sum.Files[store.Shared]...)
			if host {
				files = append(files, sum.Files[store.GM]...)
			}
			for i := range files {
				files[i].PlayerState = nil // who has filled in what is the referee's business
			}
			resp["files"] = files
			resp["players"] = sum.Players
			if me := s.me(r, id, sum.Players); me != "" {
				resp["me"] = me
			}
		}
	}
	writeJSON(w, http.StatusOK, resp)
}

func (s *Server) apiInfo(w http.ResponseWriter, r *http.Request) {
	urls := LANURLs(s.port)
	primary := fmt.Sprintf("http://localhost:%d/", s.port)
	if len(urls) > 0 {
		primary = urls[0]
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"port": s.port, "urls": urls, "primary": primary, "dataDir": s.store.Root(),
	})
}

func (s *Server) apiQR(w http.ResponseWriter, r *http.Request) {
	urls := LANURLs(s.port)
	target := fmt.Sprintf("http://localhost:%d/", s.port)
	if len(urls) > 0 {
		target = urls[0]
	}
	if u := r.URL.Query().Get("u"); u != "" {
		for _, known := range urls {
			if u == known {
				target = u
			}
		}
	}
	png, err := qrcode.Encode(target, qrcode.Medium, 512)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.Header().Set("Content-Type", "image/png")
	w.Header().Set("Cache-Control", "no-store")
	w.Write(png)
}

func (s *Server) apiListSessions(w http.ResponseWriter, r *http.Request) {
	list, err := s.store.ListSessions()
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) apiGetSession(w http.ResponseWriter, r *http.Request) {
	sum, err := s.store.GetSession(r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, sum)
}

func (s *Server) apiCreateSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name     string `json:"name"`
		GameType string `json:"gameType"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		bodyError(w, err, `{"name": ..., "gameType"?: ...}`)
		return
	}
	meta, err := s.store.CreateSession(body.Name, body.GameType)
	if err != nil {
		storeError(w, err)
		return
	}
	s.changed()
	writeJSON(w, http.StatusCreated, meta)
}

// apiUpdateSession changes the name and/or game type; absent fields stay.
func (s *Server) apiUpdateSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name     *string `json:"name"`
		GameType *string `json:"gameType"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		bodyError(w, err, `{"name"?: ..., "gameType"?: ...}`)
		return
	}
	meta, err := s.store.UpdateSession(r.PathValue("id"), body.Name, body.GameType)
	if err != nil {
		storeError(w, err)
		return
	}
	s.changed()
	writeJSON(w, http.StatusOK, meta)
}

func (s *Server) apiDeleteSession(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	s.syncMu.Lock()
	err := s.store.DeleteSession(id)
	if err == nil {
		s.hub.toRoomsWithPrefix(id+"/", map[string]string{"type": "gone"})
	}
	s.syncMu.Unlock()
	if err != nil {
		storeError(w, err)
		return
	}
	s.changed()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) apiActivate(w http.ResponseWriter, r *http.Request) {
	prev := s.store.Active()
	if err := s.store.SetActive(r.PathValue("id")); err != nil {
		storeError(w, err)
		return
	}
	if prev != "" && prev != r.PathValue("id") {
		s.hub.kickPlayers(prev + "/")
	}
	s.changed()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) apiDeactivate(w http.ResponseWriter, r *http.Request) {
	prev := s.store.Active()
	if err := s.store.SetActive(""); err != nil {
		storeError(w, err)
		return
	}
	if prev != "" {
		s.hub.kickPlayers(prev + "/")
	}
	s.changed()
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) apiReveal(w http.ResponseWriter, r *http.Request) {
	dir, err := s.store.SessionDir(r.PathValue("id"))
	if err != nil {
		storeError(w, err)
		return
	}
	if err := OpenInOS(dir); err != nil {
		jsonError(w, http.StatusInternalServerError, err.Error())
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
