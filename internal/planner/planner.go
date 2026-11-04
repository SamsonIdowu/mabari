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

var stopWords = regexp.MustCompile(`(?i)^(i|we|need|needs|want|would|like|to|please|can|you|build|create|make|set|up|start|a|an|the|our|my|for|new|me|help|with|and|that|some|so|is|of|on|it|three|short|write|research|add|improve|update)$`)

var notWord = regexp.MustCompile(`[^\w\s-]`)

// DeriveName makes a short project name from the brief: its first three words that matter.
func DeriveName(text string) string {
	var kept []string
	for _, word := range strings.Fields(notWord.ReplaceAllString(text, " ")) {
		if !stopWords.MatchString(word) {
			kept = append(kept, word)
		}
		if len(kept) == 3 {
			break
		}
	}
	if len(kept) == 0 {
		kept = []string{"New", "project"}
	}
	for index, word := range kept {
		kept[index] = upperFirst(word)
	}
	return strings.Join(kept, " ")
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
