package server

import (
	"archive/zip"
	"encoding/json"
	"io"
	"log"
	"net/http"
	"path"
	"strings"

	"mothergoose/internal/store"
)

// apiDuplicateSession makes a new campaign from another: its pages, details
// and order, and its party when asked. Never its entries.
func (s *Server) apiDuplicateSession(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Name  string `json:"name"`
		Party bool   `json:"party"`
	}
	if err := decodeBody(w, r, &body); err != nil {
		bodyError(w, err, `{"name": ..., "party"?: true}`)
		return
	}
	meta, err := s.store.DuplicateSession(r.PathValue("id"), body.Name, body.Party)
	if err != nil {
		storeError(w, err)
		return
	}
	s.changed()
	writeJSON(w, http.StatusCreated, meta)
}

// apiExportAll sends a campaign as a zip: every page as it is filled in, in
// players/ and referee/, with each player's copy of per-player pages beside
// it. Filled PDFs are made in the browser, so a PDF comes as itself plus a
// .entries.json of what was typed into it; images come as they are.
func (s *Server) apiExportAll(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	sum, err := s.store.GetSession(id)
	if err != nil {
		storeError(w, err)
		return
	}
	w.Header().Set("Content-Type", "application/zip")
	w.Header().Set("Cache-Control", "no-store")
	attachment(w, id+".zip")
	z := zip.NewWriter(w)
	defer z.Close()
	add := func(name string, b []byte) {
		f, err := z.Create(name)
		if err == nil {
			_, err = f.Write(b)
		}
		if err != nil {
			log.Printf("exporting %s/%s: %v", id, name, err)
		}
	}
	for _, sc := range store.Scopes {
		dir := sc.Label() + "/"
		for _, f := range sum.Files[sc] {
			// The starting copy, then each player's.
			copies := []string{""}
			if f.PerPlayer {
				for _, p := range sum.Players {
					copies = append(copies, p.ID)
				}
			}
			switch f.Kind {
			case store.KindHTML, store.KindMD:
				for _, pid := range copies {
					if doc, err := s.filledPage(id, sc, f.Name, pid); err == nil {
						add(dir+filledName(f.Name, pid), doc)
					} else {
						log.Printf("exporting %s/%s: %v", id, f.Name, err)
					}
				}
			case store.KindPDF:
				s.addRaw(z, id, sc, f.Name, dir+f.Name)
				stem := strings.TrimSuffix(f.Name, path.Ext(f.Name))
				for _, pid := range copies {
					st, err := s.store.GetState(id, sc, f.Name, pid)
					if err != nil || len(st) == 0 {
						continue
					}
					b, _ := json.MarshalIndent(st, "", "  ")
					name := stem
					if pid != "" {
						name += "-" + pid
					}
					add(dir+name+".entries.json", b)
				}
			default:
				s.addRaw(z, id, sc, f.Name, dir+f.Name)
			}
		}
	}
}

// addRaw adds a page file to the zip as it is.
func (s *Server) addRaw(z *zip.Writer, id string, sc store.Scope, name, as string) {
	f, _, err := s.store.OpenFile(id, sc, name)
	if err != nil {
		log.Printf("exporting %s/%s: %v", id, name, err)
		return
	}
	defer f.Close()
	out, err := z.CreateHeader(&zip.FileHeader{Name: as, Method: zip.Store})
	if err == nil {
		_, err = io.Copy(out, f)
	}
	if err != nil {
		log.Printf("exporting %s/%s: %v", id, name, err)
	}
}
