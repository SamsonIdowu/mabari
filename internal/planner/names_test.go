// SPDX-License-Identifier: Apache-2.0

package planner

import (
	"regexp"
	"strings"
	"testing"
	"unicode"
)

// A project name is the first noun phrase of the brief, not a clipped sentence (DAILY-8): it
// doesn't start with the command, and doesn't end on a little word or a verb.
func TestNamesAreNounPhrases(t *testing.T) {
	cases := []struct{ brief, name string }{
		// The two the daily tester found clipped.
		{"Build an internal dashboard that shows weekly sales by region", "Internal Dashboard"},
		{"Research three competitors and write a short report on their pricing", "Competitors"},
		// Briefs the prototype named well keep their names.
		{"I need a landing page for our coffee shop with online ordering, and tests so checkout never breaks", "Landing Page Coffee"},
		{"Create a coffee shop website", "Coffee Shop Website"},
		{"Write a blog post about our new pricing", "Blog Post Pricing"},
		{"Fix the login bug on the mobile app", "Login Bug Mobile"},
		{"Add dark mode to the email templates", "Dark Mode Email"},
		{"e-commerce store with a cart", "E-commerce Store"},
		// A command at the start goes, wherever the phrase ends.
		{"Compare three charting libraries for the dashboard", "Charting Libraries Dashboard"},
		{"Migrate the database to Postgres", "Database Postgres"},
		// A clause break ends the name, and a verb after the phrase does too.
		{"Customer portal, so people can see their orders", "Customer Portal"},
		{"A dashboard shows sales", "Dashboard"},
		{"Release notes for version 2.4", "Release Notes Version"},
		{"node.js service for payments", "Node.js Service Payments"},
		{"Python 3 migration plan", "Python 3 Migration"},
		// Nothing of use left.
		{"", "New Project"},
		{"   ", "New Project"},
		{"!!! ... ???", "New Project"},
		{"I need to build a", "New Project"},
	}
	for _, tc := range cases {
		if got := DeriveName(tc.brief); got != tc.name {
			t.Errorf("DeriveName(%q) = %q, want %q", tc.brief, got, tc.name)
		}
	}
}

// Accented and non-Latin letters are kept, not dropped (SETUP-11). "Café ordering für Zürich app"
// was "Caf Ordering F", and "Ünïcödé thing" was "N C D".
func TestNamesKeepAccentsAndOtherScripts(t *testing.T) {
	cases := []struct{ brief, name string }{
		{"Café ordering für Zürich app", "Café Ordering Zürich"},
		{"Ünïcödé thing", "Ünïcödé Thing"},
		{"Créer une application pour le café", "Créer Application Café"},
		{"Crear una tienda para el barrio", "Crear Tienda Barrio"},
		{"Zażółć gęślą jaźń", "Zażółć Gęślą Jaźń"},
		{"Магазин кофе для города", "Магазин Кофе Города"},
		{"קפה לעיר", "קפה לעיר"},
		// Chinese, Japanese and Korean have no spaces, so a clause is one word and the name is its
		// start.
		{"做一个咖啡店的网站", "做一个咖啡店的网站"},
		{"ミニマルなカフェのウェブサイトを作りたい", "ミニマルなカフェのウェブ"},
		{"커피숍 주문 앱 만들기", "커피숍 주문 앱"},
		{"做一个 coffee 网站", "做一个 Coffee 网站"},
		// Some letters, then a symbol: the letters stay.
		{"C++ refactor", "C Refactor"},
	}
	for _, tc := range cases {
		got := DeriveName(tc.brief)
		if got != tc.name {
			t.Errorf("DeriveName(%q) = %q, want %q", tc.brief, got, tc.name)
		}
		if got == "New Project" || strings.TrimSpace(got) == "" {
			t.Errorf("DeriveName(%q) fell back to %q", tc.brief, got)
		}
		for _, r := range got {
			if r == unicode.ReplacementChar {
				t.Errorf("DeriveName(%q) = %q has a broken character", tc.brief, got)
			}
		}
	}
	// Only when no letters remain does it fall back.
	for _, brief := range []string{"123 !!!", "---", "🙂🙂🙂"} {
		want := "New Project"
		if brief == "123 !!!" {
			want = "123"
		}
		if got := DeriveName(brief); got != want {
			t.Errorf("DeriveName(%q) = %q, want %q", brief, got, want)
		}
	}
}

// Names are never cut through a character, and a very long word doesn't make a very long name.
func TestNamesStayShort(t *testing.T) {
	long := DeriveName(strings.Repeat("é", 100) + " " + strings.Repeat("x", 100))
	for _, word := range strings.Fields(long) {
		if len([]rune(word)) > 24 {
			t.Errorf("a word of %d letters in %q", len([]rune(word)), long)
		}
	}
	if got := DeriveName(strings.Repeat("修", 100)); len([]rune(got)) > 12 {
		t.Errorf("%d letters of Chinese in %q", len([]rune(got)), got)
	}
	// The server refuses a name longer than NameMax, so the plan's own name always fits: it drops
	// its last words, never the end of one.
	for brief, want := range map[string]string{
		"Internationalization documentation infrastructure": "Internationalization",
		"Customer onboarding dashboard":                     "Customer Onboarding",
		"Authentication authorization accounting":           "Authentication Authorization",
		strings.Repeat("é", 40):                             strings.Repeat("é", 24),
	} {
		got := DeriveName(brief)
		if len([]rune(got)) > NameMax {
			t.Errorf("DeriveName(%q) = %q, longer than %d", brief, got, NameMax)
		}
		if want = upperFirst(want); got != want {
			t.Errorf("DeriveName(%q) = %q, want %q", brief, got, want)
		}
	}
}

// The lead's task and every member's task are built from the name, so they read well too.
func TestTasksFollowTheName(t *testing.T) {
	plan := Make(Examples[2], Examples[2], nil, claudeOffice)
	if want := "Plan internal dashboard, split the work and keep everyone in sync"; plan.LeadTask != want {
		t.Errorf("lead task = %q, want %q", plan.LeadTask, want)
	}
	plan = Make(Examples[1], Examples[1], nil, claudeOffice)
	if want := "Plan competitors, split the work and keep everyone in sync"; plan.LeadTask != want {
		t.Errorf("lead task = %q, want %q", plan.LeadTask, want)
	}
	for _, member := range plan.Members {
		if strings.Contains(member.Task, "their") || strings.Contains(member.Task, "shows") {
			t.Errorf("member task = %q", member.Task)
		}
	}
	accented := Make("Café ordering für Zürich app", "Café ordering für Zürich app", nil, claudeOffice)
	if accented.Name != "Café Ordering Zürich" ||
		accented.LeadTask != "Plan café ordering zürich, split the work and keep everyone in sync" {
		t.Errorf("accented plan = %q, %q", accented.Name, accented.LeadTask)
	}
	// "call it" with accents works too.
	renamed := Make("build it. call it Crème Brûlée", "call it Crème Brûlée", nil, claudeOffice)
	if renamed.Name != "Crème brûlée" {
		t.Errorf("renamed = %q", renamed.Name)
	}
}

// A folder name from a project name has only plain letters, and never comes out empty.
func TestSlug(t *testing.T) {
	for name, want := range map[string]string{
		"Landing Page Coffee":    "landing-page-coffee",
		"Café Ordering Zürich":   "cafe-ordering-zurich",
		"Straße":                 "strasse",
		"Ünïcödé Thing":          "unicode-thing",
		"  Shop  Admin!! ":       "shop-admin",
		"E-commerce Store":       "e-commerce-store",
		"":                       "project",
		"Crème brûlée (version)": "creme-brulee-version",
	} {
		if got := Slug(name); got != want {
			t.Errorf("Slug(%q) = %q, want %q", name, got, want)
		}
	}
}

// REV-6: a name with no plain letters to write still gets a folder, and two such names never share
// one, so two projects named in Japanese and Russian don't work in the same place. The folder is
// the same each time for the same name.
func TestSlugFallbackIsUniqueToTheName(t *testing.T) {
	plain := regexp.MustCompile(`^project-[0-9a-f]{8}$`)
	names := []string{"做一个咖啡店的网站", "Привет", "---", "!!!", "咖啡店", "日本語のアプリ", "مرحبا", "😀😀"}
	seen := map[string]string{}
	for _, name := range names {
		got := Slug(name)
		if !plain.MatchString(got) {
			t.Errorf("Slug(%q) = %q, want project- and eight hex digits", name, got)
		}
		if got != Slug(name) {
			t.Errorf("Slug(%q) changes between calls", name)
		}
		if other, taken := seen[got]; taken {
			t.Errorf("%q and %q share the folder %q", name, other, got)
		}
		seen[got] = name
	}
	// Spacing and case don't make a name another name, as they don't for the plain slug.
	if Slug("  Привет ") != Slug("привет") {
		t.Error("the same name in other spacing or case got another folder")
	}
}
