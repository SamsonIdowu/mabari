// SPDX-License-Identifier: Apache-2.0

// Package planner turns a project brief into a team: a lead and up to three subagents, with
// tasks and an estimated time to completion. It ports the prototype's makePlan rules, so the
// same words give the same team. Follow-up messages change the plan: "call it …", "use Codex",
// "no tests".
package planner

import (
	"regexp"
	"strconv"
	"strings"
	"unicode"
	"unicode/utf8"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// Role is one kind of subagent.
type Role string

// Roles, in the prototype's order, which decides the team's order.
const (
	RoleResearch Role = "research"
	RoleBuild    Role = "build"
	RoleTest     Role = "test"
	RoleWrite    Role = "write"
	RoleData     Role = "data"
)

type rule struct {
	role    Role
	label   string
	pattern *regexp.Regexp
	task    string
	minutes int
}

// rules are the prototype's ROLE_PLAN and ROLE_MIN.
var rules = []rule{
	{RoleResearch, "Researcher", regexp.MustCompile(`research|compare|competitor|market|find out|look into|pricing`), "Research what's needed for {s}", 20},
	{RoleBuild, "Builder", regexp.MustCompile(`build|app|site|page|api|feature|fix|bug|code|implement|integrat|dashboard|checkout|login|ordering|landing`), "Build {s}", 45},
	{RoleTest, "Tester", regexp.MustCompile(`test|qa|break|reliab|bug`), "Write and run tests for {s}", 25},
	{RoleWrite, "Writer", regexp.MustCompile(`write|docs|blog|copy|readme|email|content|guide|report`), "Write the copy and docs for {s}", 20},
	{RoleData, "Analyst", regexp.MustCompile(`data|analy|metric|chart|sales|numbers|weekly`), "Prepare and check the data for {s}", 25},
}

func ruleFor(role Role) rule {
	for _, r := range rules {
		if r.role == role {
			return r
		}
	}
	return rules[1]
}

// FreshNames are offered to new agents in order, skipping names already in use.
var FreshNames = []string{
	"Juniper", "Orion", "Maple", "Nova", "Basil", "Cedar", "Wren", "Echo",
	"Sol", "Pip", "Kit", "Fern", "Onyx", "Reed", "Tansy", "Lumen",
}

// Examples are the briefs offered before the user types.
var Examples = []string{
	"I need a landing page for our coffee shop with online ordering, and tests so checkout never breaks",
	"Research three competitors and write a short report on their pricing",
	"Build an internal dashboard that shows weekly sales by region",
}

// Member is one subagent in the plan.
type Member struct {
	Role    Role   `json:"role"`
	Label   string `json:"label"`
	Name    string `json:"name"`
	Task    string `json:"task"`
	On      bool   `json:"on"`
	Minutes int    `json:"minutes"`
}

// Plan is a proposed team for a project.
type Plan struct {
	Name      string             `json:"name"`
	Color     string             `json:"color"`
	Account   models.AccountKind `json:"account"`
	LeadName  string             `json:"leadName"`
	LeadModel string             `json:"leadModel"`
	SubModel  string             `json:"subModel"`
	LeadTask  string             `json:"leadTask"`
	Members   []Member           `json:"members"`
	// Minutes is the estimated time to completion, from Minutes.
	Minutes int `json:"minutes"`
}

// Office is what the planner needs to know about the office.
type Office struct {
	// Connected says which accounts can run agents now.
	Connected map[models.AccountKind]bool
	// Taken are names already in use.
	Taken func(name string) bool
	// AgentCount and ProjectCount pick fallback names and the next colour.
	AgentCount   int
	ProjectCount int
	// Defaults are the default models by account, keyed as in Settings.Defaults.
	Defaults map[string]string
}

// defaultsKey is how Settings.Defaults names each account.
var defaultsKey = map[models.AccountKind]string{
	models.AccountClaudeCode: "claude", models.AccountCodex: "codex",
	models.AccountAnthropicKey: "anthropic", models.AccountOpenAIKey: "openai",
}

// Minutes is the prototype's planMinutes: 10 to plan, the longest subagent task, 10 to review.
// Subagents work at the same time, so the longest task sets the pace.
func Minutes(plan Plan) int {
	longest := 20
	found := false
	for _, member := range plan.Members {
		if !member.On {
			continue
		}
		minutes := ruleFor(member.Role).minutes
		if !found || minutes > longest {
			longest, found = minutes, true
		}
	}
	return 10 + longest + 10
}

func wordSet(words string) map[string]bool {
	set := map[string]bool{}
	for _, word := range strings.Fields(words) {
		set[word] = true
	}
	return set
}

var (
	// fillers are skipped wherever they come: the prototype's stop words, with a few more English
	// ones and the common little words of German, French, Spanish and Italian, so "Café ordering
	// für Zürich app" doesn't end on "für".
	fillers = wordSet(`i we need needs want would like to please can you build create make set up start a an
		the our my for new me help and with that some so is of on it three short write research add improve update
		about in at from into as their its your them they this these those what any every each also just really
		very der die das den dem ein eine einen und mit für von zu im am le la les un une des du de et pour avec
		dans sur el los las una unos unas y con para por del al il lo gli i per e di da для и на с в по`)
	// boundaries end the name once it has a word: it is the first noun phrase, not the whole
	// sentence. "an internal dashboard that shows weekly sales" is "Internal Dashboard".
	boundaries = wordSet(`and or but that which who whom whose where when while because so then than if with
		without using via by per plus`)
	// leadingVerbs start a brief as a command and aren't part of the name: "research competitors"
	// is "Competitors". Anywhere else they may be a noun ("login fix"), so only a leading one goes.
	leadingVerbs = wordSet(`compare find design develop fix migrate refactor implement redesign rewrite review
		audit analyze analyse summarize summarise investigate document deploy integrate optimize optimise
		generate prepare draft plan organize organise clean convert collect track monitor show list explain
		check run go get put launch ship publish`)
	// endingVerbs, after a word of the name, say what the thing does, and end it: "a dashboard shows
	// sales" is "Dashboard".
	endingVerbs = wordSet(`shows showing displays tracks tracking lets allows helps makes gives provides sends
		reads writes handles monitors manages generates compares collects runs does has have gets uses takes
		keeps looks works checks scans converts turns finds stores syncs lists updates should must will could
		may might are was were be being`)
)

// nameWords is how many words a project name has at most.
const nameWords = 3

// clauseBreaks end a clause. A name comes from the first clause that has words in it.
const clauseBreaks = ",;:.!?()—–\n、。，；：！？（）"

type piece struct {
	text string
	// breakBefore says a clause ended between this word and the one before.
	breakBefore bool
}

// splitWords splits text into words, as letters and digits in any script, keeping a hyphen or an
// apostrophe inside a word ("e-commerce", "don't"). Everything else separates words, and a full
// stop, comma or the like ends a clause, unless it sits inside a word, as in "node.js" and "2.4".
func splitWords(text string) []piece {
	var found []piece
	var current []rune
	broke := false
	flush := func() {
		if trimmed := strings.Trim(string(current), "-'’_"); trimmed != "" {
			found = append(found, piece{trimmed, broke})
			broke = false
		}
		current = current[:0]
	}
	runes := []rune(text)
	for index, r := range runes {
		insideWord := len(current) > 0 && index+1 < len(runes) &&
			(unicode.IsLetter(runes[index+1]) || unicode.IsDigit(runes[index+1]))
		switch {
		case unicode.IsLetter(r) || unicode.IsDigit(r) || unicode.IsMark(r) || r == '_':
			current = append(current, r)
		case (r == '-' || r == '\'' || r == '’') && len(current) > 0:
			current = append(current, r)
		case r == '.' && insideWord:
			// A full stop inside a word, as in "node.js" or "2.4", doesn't end a clause or the word.
			current = append(current, r)
		default:
			flush()
			if strings.ContainsRune(clauseBreaks, r) {
				broke = true
			}
		}
	}
	flush()
	return found
}

// isCJK reports whether a word is written in Chinese, Japanese or Korean, which has no spaces
// between words, so a "word" is a whole clause.
func isCJK(text string) bool {
	for _, r := range text {
		if unicode.Is(unicode.Han, r) || unicode.Is(unicode.Hiragana, r) || unicode.Is(unicode.Katakana, r) ||
			unicode.Is(unicode.Hangul, r) {
			return true
		}
	}
	return false
}

// DeriveName makes a short project name from the brief: the first words that matter, in the first
// clause that has any, as many as three. It leaves out the little words, a verb the brief starts
// with, and everything after the first noun phrase ends, so a name never ends on "their" or
// "shows". Letters in any script are kept, and a brief with none gives "New Project".
func DeriveName(text string) string {
	var kept []string
	for _, next := range splitWords(text) {
		if next.breakBefore && len(kept) > 0 {
			break
		}
		lower := strings.ToLower(next.text)
		ended := false
		switch {
		case boundaries[lower]:
			ended = len(kept) > 0
		case len(kept) == 0 && leadingVerbs[lower], fillers[lower]:
		case len(kept) > 0 && endingVerbs[lower]:
			ended = true
		default:
			// A phrase in a language written without spaces is one long "word": a name is only
			// its start, and nothing follows it.
			limit := 24
			if isCJK(next.text) {
				limit = 12
			}
			clipped := models.Clip(next.text, limit)
			kept = append(kept, clipped)
			ended = clipped != next.text
		}
		if ended || len(kept) == nameWords {
			break
		}
	}
	if len(kept) == 0 {
		kept = []string{"New", "project"}
	}
	for index, name := range kept {
		kept[index] = upperFirst(name)
	}
	// A name that wouldn't fit gives up its last words, not its end in the middle of one.
	for len(kept) > 1 && utf8.RuneCountInString(strings.Join(kept, " ")) > NameMax {
		kept = kept[:len(kept)-1]
	}
	return strings.Join(kept, " ")
}

// NameMax is the longest project name, in characters, which the server accepts.
const NameMax = 28

var folded = strings.NewReplacer(
	"à", "a", "á", "a", "â", "a", "ã", "a", "ä", "a", "å", "a", "ā", "a", "ă", "a", "ą", "a",
	"ç", "c", "ć", "c", "č", "c", "ď", "d", "đ", "d",
	"è", "e", "é", "e", "ê", "e", "ë", "e", "ē", "e", "ę", "e", "ě", "e",
	"ì", "i", "í", "i", "î", "i", "ï", "i", "ī", "i", "ı", "i",
	"ł", "l", "ñ", "n", "ń", "n", "ň", "n",
	"ò", "o", "ó", "o", "ô", "o", "õ", "o", "ö", "o", "ø", "o", "ō", "o", "ő", "o",
	"ř", "r", "ś", "s", "š", "s", "ş", "s", "ß", "ss", "ť", "t",
	"ù", "u", "ú", "u", "û", "u", "ü", "u", "ū", "u", "ů", "u", "ű", "u",
	"ý", "y", "ÿ", "y", "ź", "z", "ž", "z", "ż", "z", "æ", "ae", "œ", "oe",
)

var notSlug = regexp.MustCompile(`[^a-z0-9]+`)

// Slug turns a name into a folder name: "Café ordering für Zürich" is "cafe-ordering-fur-zurich".
// Letters with no plain form are left out, and a name with none, such as one in Japanese, is
// "project", so there is always something to call the folder.
func Slug(name string) string {
	slug := strings.Trim(notSlug.ReplaceAllString(folded.Replace(strings.ToLower(name)), "-"), "-")
	if slug == "" {
		return "project"
	}
	return slug
}

func upperFirst(text string) string {
	first, size := utf8.DecodeRuneInString(text)
	if size == 0 {
		return text
	}
	return string(unicode.ToUpper(first)) + text[size:]
}

// TitleCase turns a folder name such as "coffee-shop" into "Coffee Shop".
func TitleCase(text string) string {
	words := strings.Fields(strings.NewReplacer("-", " ", "_", " ").Replace(text))
	for index, word := range words {
		words[index] = upperFirst(word)
	}
	return strings.Join(words, " ")
}

func freshName(office Office, taken []string) string {
	for _, name := range FreshNames {
		inUse := office.Taken != nil && office.Taken(name)
		for _, other := range taken {
			inUse = inUse || other == name
		}
		if !inUse {
			return name
		}
	}
	return "Agent " + strconv.Itoa(office.AgentCount+len(taken)+1)
}

var (
	callIt   = regexp.MustCompile(`call it ([^.,!?]+)`)
	removals = regexp.MustCompile(`(?:no|without|remove|drop)\s+(?:the\s+)?(research\w*|test\w*|docs|writ\w*|copy|data|analys\w*|build\w*)`)
	wantsGPT = regexp.MustCompile(`codex|openai|chatgpt|gpt`)
)

// account picks who runs the team: the earlier choice, then whatever is connected, with
// "use Codex" or "use Claude" in the latest message switching it.
func account(office Office, latest string, old *Plan) models.AccountKind {
	choice := models.AccountClaudeCode
	switch {
	case old != nil:
		choice = old.Account
	case office.Connected[models.AccountClaudeCode]:
	case office.Connected[models.AccountCodex]:
		choice = models.AccountCodex
	case office.Connected[models.AccountAnthropicKey]:
		choice = models.AccountAnthropicKey
	case office.Connected[models.AccountOpenAIKey]:
		choice = models.AccountOpenAIKey
	}
	if wantsGPT.MatchString(latest) {
		choice = models.AccountCodex
		if office.Connected[models.AccountOpenAIKey] && !office.Connected[models.AccountCodex] {
			choice = models.AccountOpenAIKey
		}
	}
	if strings.Contains(latest, "claude") {
		choice = models.AccountClaudeCode
	}
	return choice
}

// Make plans a team from everything said so far, the latest message and the earlier plan, if
// any. Names, ticks and colour carry over from the earlier plan.
func Make(all, latest string, old *Plan, office Office) Plan {
	text, latestLower := strings.ToLower(all), strings.ToLower(latest)
	choice := account(office, latestLower, old)
	name := DeriveName(all)
	if old != nil {
		name = old.Name
	}
	if found := callIt.FindStringSubmatch(latestLower); found != nil {
		name = upperFirst(strings.TrimSpace(found[1]))
	}
	subject := strings.ToLower(name)
	var picked []Role
	for _, r := range rules {
		if r.pattern.MatchString(text) {
			picked = append(picked, r.role)
		}
	}
	for _, removal := range removals.FindAllString(text, -1) {
		// The prototype's own matching, kept exactly: a role goes if its first four letters appear.
		removal = strings.Replace(strings.Replace(strings.Replace(removal, "writ", "write", 1), "analys", "data", 1), "copy", "write", 1)
		kept := picked[:0:0]
		for _, role := range picked {
			if !strings.Contains(removal, string(role)[:4]) {
				kept = append(kept, role)
			}
		}
		picked = kept
	}
	if len(picked) == 0 {
		picked = []Role{RoleBuild, RoleTest}
	}
	if len(picked) > 3 {
		picked = picked[:3]
	}
	var taken []string
	leadName := freshName(office, taken)
	if old != nil {
		leadName = old.LeadName
	}
	taken = append(taken, leadName)
	members := make([]Member, 0, len(picked))
	for _, role := range picked {
		r := ruleFor(role)
		member := Member{Role: role, Label: r.label, Task: strings.ReplaceAll(r.task, "{s}", subject), On: true, Minutes: r.minutes}
		var previous *Member
		if old != nil {
			for index := range old.Members {
				if old.Members[index].Role == role {
					previous = &old.Members[index]
					break
				}
			}
		}
		if previous != nil {
			member.Name, member.On = previous.Name, previous.On
		} else {
			member.Name = freshName(office, taken)
		}
		taken = append(taken, member.Name)
		members = append(members, member)
	}
	claudeFamily := choice == models.AccountClaudeCode || choice == models.AccountAnthropicKey
	leadModel, subModel := "gpt-5-codex", "gpt-5-mini"
	if claudeFamily {
		leadModel, subModel = "claude-sonnet-4-5", "claude-haiku-4-5"
	}
	if model := office.Defaults[defaultsKey[choice]]; model != "" {
		leadModel = model
	}
	color := models.ProjectColors[office.ProjectCount%len(models.ProjectColors)]
	if old != nil {
		color = old.Color
	}
	plan := Plan{
		Name: name, Color: color, Account: choice, LeadName: leadName,
		LeadModel: leadModel, SubModel: subModel,
		LeadTask: "Plan " + subject + ", split the work and keep everyone in sync",
		Members:  members,
	}
	plan.Minutes = Minutes(plan)
	return plan
}

// Joined lists items the prototype's way: "a", "a and b", "a, b and c".
func Joined(items []string) string {
	switch len(items) {
	case 0:
		return ""
	case 1:
		return items[0]
	default:
		return strings.Join(items[:len(items)-1], ", ") + " and " + items[len(items)-1]
	}
}

// Reply is the planner's message with a plan: what it read, then who does what.
func Reply(plan Plan, first bool, read []string) string {
	on := 0
	for _, member := range plan.Members {
		if member.On {
			on++
		}
	}
	text := ""
	if len(read) > 0 {
		text = "I read " + Joined(read) + ". "
	}
	if first {
		text += "Here's a team for it. "
	} else {
		text += "Updated. "
	}
	sits := " subagents sit"
	if on == 1 {
		sits = " subagent sits"
	}
	return text + plan.LeadName + " leads and splits the work, and " + strconv.Itoa(on) + sits + " in " +
		plan.LeadName + "'s office. Untick anyone you don't need, or tell me what to change."
}
