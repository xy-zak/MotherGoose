// Package pages holds what MotherGoose knows about the contents of pages:
// turning a Markdown page into HTML, and checking that an HTML page is
// self-contained (everything it needs inside the one file).
package pages

import (
	"bytes"
	"fmt"
	"regexp"
	"strings"

	"github.com/yuin/goldmark"
	"github.com/yuin/goldmark/ast"
	"github.com/yuin/goldmark/extension"
	extast "github.com/yuin/goldmark/extension/ast"
	"github.com/yuin/goldmark/parser"
	"github.com/yuin/goldmark/renderer"
	"github.com/yuin/goldmark/text"
	"github.com/yuin/goldmark/util"
)

// md renders GitHub-flavoured Markdown: tables, strikethrough, bare links
// and task lists. Raw HTML is left out (goldmark's default), and so are
// links to javascript:, vbscript:, file: and data: (other than images), so a
// Markdown page can't run code. Task-list boxes become real checkboxes with
// stable ids, which the page script saves and syncs like any field.
var md = goldmark.New(
	goldmark.WithExtensions(extension.Table, extension.Strikethrough, extension.Linkify),
	goldmark.WithParserOptions(
		parser.WithAutoHeadingID(),
		parser.WithInlineParsers(util.Prioritized(extension.NewTaskCheckBoxParser(), 0)),
		parser.WithASTTransformers(util.Prioritized(linksOut{}, 100)),
	),
	goldmark.WithRendererOptions(
		renderer.WithNodeRenderers(util.Prioritized(taskBoxes{}, 100)),
	),
)

// Markdown renders a Markdown page's body, and returns its title: the text
// of its first level-1 heading, or "".
func Markdown(src []byte) ([]byte, string, error) {
	doc := md.Parser().Parse(text.NewReader(src))
	title := ""
	ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if h, ok := n.(*ast.Heading); ok && entering && h.Level == 1 {
			title = strings.Join(strings.Fields(plainText(h, src)), " ")
			return ast.WalkStop, nil
		}
		return ast.WalkContinue, nil
	})
	var b bytes.Buffer
	if err := md.Renderer().Render(&b, src, doc); err != nil {
		return nil, "", fmt.Errorf("rendering Markdown: %w", err)
	}
	if len(title) > 80 {
		title = title[:80]
	}
	return b.Bytes(), title, nil
}

// plainText is the text inside a node, without its markup.
func plainText(n ast.Node, src []byte) string {
	var b strings.Builder
	ast.Walk(n, func(c ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		switch t := c.(type) {
		case *ast.Text:
			b.Write(t.Segment.Value(src))
			if t.SoftLineBreak() || t.HardLineBreak() {
				b.WriteByte(' ')
			}
		case *ast.String:
			b.Write(t.Value)
		case *ast.CodeSpan:
			for l := t.FirstChild(); l != nil; l = l.NextSibling() {
				if tx, ok := l.(*ast.Text); ok {
					b.Write(tx.Segment.Value(src))
				}
			}
			return ast.WalkSkipChildren, nil
		}
		return ast.WalkContinue, nil
	})
	return b.String()
}

// linksOut opens links to other places in a new tab: inside the player
// view, following one would replace the page in its frame. Links within the
// page (#heading) stay put.
type linksOut struct{}

func (linksOut) Transform(doc *ast.Document, _ text.Reader, _ parser.Context) {
	ast.Walk(doc, func(n ast.Node, entering bool) (ast.WalkStatus, error) {
		if !entering {
			return ast.WalkContinue, nil
		}
		var dest []byte
		switch l := n.(type) {
		case *ast.Link:
			dest = l.Destination
		case *ast.AutoLink:
			dest = []byte("x") // always somewhere else
		default:
			return ast.WalkContinue, nil
		}
		if !bytes.HasPrefix(dest, []byte("#")) {
			n.SetAttributeString("target", []byte("_blank"))
			n.SetAttributeString("rel", []byte("noopener noreferrer"))
		}
		return ast.WalkContinue, nil
	})
}

// taskBoxes renders "- [ ] item" as an enabled checkbox whose id comes from
// the item's text ("task-find-the-key"), so a box keeps its saved value when
// items are added or moved. The page script tells repeats apart.
type taskBoxes struct{}

func (taskBoxes) RegisterFuncs(reg renderer.NodeRendererFuncRegisterer) {
	reg.Register(extast.KindTaskCheckBox, renderTaskBox)
}

var slugRe = regexp.MustCompile(`[^\p{L}\p{N}]+`)

func renderTaskBox(w util.BufWriter, src []byte, n ast.Node, entering bool) (ast.WalkStatus, error) {
	if !entering {
		return ast.WalkContinue, nil
	}
	label := ""
	if p := n.Parent(); p != nil {
		label = plainText(p, src)
	}
	slug := strings.Trim(slugRe.ReplaceAllString(strings.ToLower(label), "-"), "-")
	if len(slug) > 60 {
		slug = strings.Trim(slug[:60], "-")
	}
	if slug == "" {
		slug = "item"
	}
	_, _ = w.WriteString(`<input type="checkbox" class="task" id="task-`)
	_, _ = w.Write(util.EscapeHTML([]byte(slug)))
	_, _ = w.WriteString(`" aria-label="`)
	_, _ = w.Write(util.EscapeHTML([]byte(strings.TrimSpace(label))))
	_ = w.WriteByte('"')
	if n.(*extast.TaskCheckBox).IsChecked {
		_, _ = w.WriteString(" checked")
	}
	_, _ = w.WriteString("> ")
	return ast.WalkContinue, nil
}
