package server

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"

	"mothergoose/internal/store"
)

// ---- who is this device? -----------------------------------------------------

// whoCookie remembers which player this device picked, per session: a
// base64url-encoded JSON object of session id -> player id. Players pick their
// own name on the honour system, so the cookie isn't signed; it only has to
// survive being garbled, edited or left over from a deleted session.
const whoCookie = "mg_who"

// maxWhoLen keeps the cookie well under the 4 KiB browsers allow.
const maxWhoLen = 3000

// readWho returns the device's picks. Anything that doesn't decode counts as
// no picks at all, and entries that can't be a session and player are dropped.
func readWho(r *http.Request) map[string]string {
	out := map[string]string{}
	c, err := r.Cookie(whoCookie)
	if err != nil {
		return out
	}
	b, err := base64.RawURLEncoding.DecodeString(c.Value)
	if err != nil {
		return out
	}
	var m map[string]string
	if json.Unmarshal(b, &m) != nil {
		return out
	}
	for sess, pl := range m {
		if len(sess) <= 200 && store.ValidPlayerID(pl) {
			out[sess] = pl
		}
	}
	return out
}

func writeWho(w http.ResponseWriter, m map[string]string) {
	c := &http.Cookie{
		Name: whoCookie, Path: "/", MaxAge: 365 * 24 * 60 * 60,
		HttpOnly: true, SameSite: http.SameSiteStrictMode,
	}
	if len(m) == 0 {
		c.MaxAge = -1 // nothing left to remember: delete it
	} else {
		b, _ := json.Marshal(m)
		c.Value = base64.RawURLEncoding.EncodeToString(b)
	}
	http.SetCookie(w, c)
}

// me is this device's player in a session, if they are on its roster. A
// player taken off the roster and added back (same id) is recognised again.
func (s *Server) me(r *http.Request, id string, players []store.Player) string {
	pid := readWho(r)[id]
	if (store.PageAccess{Players: players}).HasPlayer(pid) {
		return pid
	}
	return ""
}

// apiMe sets or clears this device's player in the live session:
// {"player": "ana"} or {"player": null}.
func (s *Server) apiMe(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Player json.RawMessage `json:"player"`
	}
	const want = `{"player": "<id>" | null}`
	if err := decodeBody(w, r, &body); err != nil {
		bodyError(w, err, want)
		return
	}
	var pid *string
	if body.Player == nil || json.Unmarshal(body.Player, &pid) != nil {
		jsonError(w, http.StatusBadRequest, "expected "+want)
		return
	}
	id := s.store.Active()
	if id == "" {
		jsonError(w, http.StatusConflict, "No session is live right now.")
		return
	}
	players, err := s.store.Players(id)
	if err != nil {
		storeError(w, err)
		return
	}
	who := readWho(r)
	// Forget sessions that have since been deleted, so the cookie can't grow
	// without end; if it is still too big, keep only the live session.
	for sess := range who {
		if _, err := s.store.SessionDir(sess); err != nil {
			delete(who, sess)
		}
	}
	if pid == nil {
		delete(who, id)
	} else {
		if !(store.PageAccess{Players: players}).HasPlayer(*pid) {
			jsonError(w, http.StatusBadRequest, fmt.Sprintf("There is no player %q in this session.", *pid))
			return
		}
		who[id] = *pid
	}
	if b, _ := json.Marshal(who); base64.RawURLEncoding.EncodedLen(len(b)) > maxWhoLen {
		keep := map[string]string{}
		if pid != nil {
			keep[id] = *pid
		}
		who = keep
	}
	writeWho(w, who)
	writeJSON(w, http.StatusOK, map[string]any{"me": pid})
}

// ---- which copy of a page? ---------------------------------------------------

// accessError is a refusal to open a copy of a per-player page.
type accessError struct {
	status  int
	heading string // for the HTML page shown in a frame
	msg     string
}

func (e *accessError) Error() string { return e.msg }

// copyFor decides which entries a request for a page works on: "" is the
// page's own, otherwise a player's copy. Only per-player pages have copies;
// other pages ignore the player asked for. On a per-player page the host may
// open the template (no player) or any rostered player's copy, while every
// other device may open only the copy of the player it picked.
func (s *Server) copyFor(r *http.Request, id string, sc store.Scope, name, player string) (string, error) {
	if !store.CanBePerPlayer(sc, kind(name)) {
		return "", nil
	}
	a, err := s.store.Access(id, sc, name)
	if err != nil {
		return "", err
	}
	if !a.PerPlayer {
		return "", nil
	}
	if s.isHost(r) {
		if player != "" && !a.HasPlayer(player) {
			return "", &accessError{http.StatusNotFound, "No such player", fmt.Sprintf("There is no player %q in this session.", player)}
		}
		return player, nil
	}
	me := s.me(r, id, a.Players)
	switch {
	case me == "":
		return "", &accessError{http.StatusForbidden, "Who are you?", "Pick your name first."}
	case player == "":
		return "", &accessError{http.StatusForbidden, "Not your copy", "Players can only open their own copy of this page."}
	case player != me:
		return "", &accessError{http.StatusForbidden, "Not your copy", "That is another player's copy. Players can only open their own."}
	}
	return me, nil
}

func kind(name string) store.Kind {
	k, _ := store.KindOf(name)
	return k
}

// accessFail reports an error from copyFor.
func (s *Server) accessFail(w http.ResponseWriter, r *http.Request, err error) {
	ae, ok := err.(*accessError)
	switch {
	case !ok:
		storeError(w, err)
	case ae.status == http.StatusForbidden:
		s.forbidPage(w, r, "Per-player page", ae.heading, ae.msg)
	default:
		jsonError(w, ae.status, ae.msg)
	}
}

// ---- roster (referee only) ---------------------------------------------------

func (s *Server) apiAddPlayer(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		bodyError(w, err, `{"name": ...}`)
		return
	}
	p, err := s.store.AddPlayer(r.PathValue("id"), body.Name)
	if err != nil {
		storeError(w, err)
		return
	}
	s.changed()
	writeJSON(w, http.StatusCreated, p)
}

func (s *Server) apiRenamePlayer(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name string `json:"name"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		bodyError(w, err, `{"name": ...}`)
		return
	}
	id := r.PathValue("id")
	p, err := s.store.RenamePlayer(id, r.PathValue("player"), body.Name)
	if err != nil {
		storeError(w, err)
		return
	}
	s.hub.toPlayer(id, p.ID, map[string]string{"type": "reload"})
	s.changed()
	writeJSON(w, http.StatusOK, p)
}

// apiRemovePlayer takes a player off the roster; ?entries=delete also
// deletes their copies (the default, "keep", leaves them for re-adding).
func (s *Server) apiRemovePlayer(w http.ResponseWriter, r *http.Request) {
	id, pid := r.PathValue("id"), r.PathValue("player")
	var del bool
	switch r.URL.Query().Get("entries") {
	case "", "keep":
	case "delete":
		del = true
	default:
		jsonError(w, http.StatusBadRequest, `entries must be "keep" or "delete"`)
		return
	}
	// Under syncMu, so that no edit already checked against the old roster
	// can land after the copies are deleted and bring them back.
	s.syncMu.Lock()
	err := s.store.RemovePlayer(id, pid, del)
	if err == nil {
		s.hub.toPlayer(id, pid, map[string]string{"type": "gone"})
	}
	s.syncMu.Unlock()
	if err != nil {
		storeError(w, err)
		return
	}
	s.changed()
	w.WriteHeader(http.StatusNoContent)
}
