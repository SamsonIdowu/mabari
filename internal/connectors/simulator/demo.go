// SPDX-License-Identifier: Apache-2.0

package simulator

import (
	"time"

	"github.com/SamsonIdowu/mabari/internal/models"
)

// The demo office's data, copied from design/mabari-prototype.html.

var plan = []models.AgentState{
	models.StateThinking, models.StateReading, models.StateEditing, models.StateRunning,
	models.StateEditing, models.StateBrowsing, models.StateThinking, models.StateEditing,
}

var (
	skins = models.Skins
	hairs = models.Hairs
	hues  = models.Hues
)

// demoSlowdown stretches the demo's seeded work, so it stays on screen for longer.
const demoSlowdown = 4.5

// thinkingSpeed is how fast progress runs while an agent is thinking, against other steps.
const thinkingSpeed = 0.6

// demoPace is how many seconds of an agent's Rate pass in one real second. A tick is one real
// second and moves the office on by officeSecondsPerTick, and a thinking step is slower, so over
// the plan's steps an agent covers its Rate this many times faster than the clock. Estimates
// are told in real seconds with it, so a demo minute is a minute (FIRST-8). It is an average
// across the steps rather than the speed of the step in hand, so an estimate falls steadily and
// doesn't lurch every time an agent starts or stops thinking.
var demoPace = func() float64 {
	total := 0.0
	for _, state := range plan {
		if state == models.StateThinking {
			total += thinkingSpeed
		} else {
			total++
		}
	}
	return officeSecondsPerTick * total / float64(len(plan))
}()

// DemoQuestionAfter is how long into the demo a Claude agent asks its question. It is later than
// the first look at the floor, which is approvals and errors, and sooner than anyone has left.
const DemoQuestionAfter = 30 * time.Second

// demoAsker is the demo agent that asks the question: a Claude agent, as only Claude Code asks
// them, and one whose work the question is about.
const demoAsker = "Sage"

// demoQuestion is what it asks, in the shape Claude Code's AskUserQuestion has: questions with
// options to pick from and a line on what each means, one that takes several answers, and a place
// to type something else. Asking it stops the agent until you answer in its panel.
var demoQuestion = models.Question{Items: []models.QuestionItem{
	{
		Question: "Which pagination style should the orders API use?", Header: "Pagination",
		Options: []models.QuestionOption{
			{Label: "Cursor-based", Description: "Stable while orders change. The client sends the last id it saw."},
			{Label: "Page numbers", Description: "Simple, and the client can jump to any page. Slower on big tables."},
			{Label: "Offset and limit", Description: "The familiar form. Can skip or repeat orders when new ones arrive."},
		},
	},
	{
		Question: "What else should it include?", Header: "Extras", MultiSelect: true,
		Options: []models.QuestionOption{
			{Label: "Total count", Description: "Costs an extra query on every request."},
			{Label: "Link headers", Description: "Next and previous links, as GitHub does."},
			{Label: "API docs", Description: "Update the reference for the new parameters."},
		},
	},
}}

// demoTasks is what idle demo agents pick up next.
var demoTasks = []string{
	"Add input validation to the signup form",
	"Write release notes for version 2.4",
	"Fix the flaky date picker test",
	"Speed up the product search query",
	"Translate the settings page to Spanish",
	"Clean up unused CSS in the dashboard",
	"Add retry logic to the payment webhook",
	"Document the public API endpoints",
	"Upgrade the charting library",
	"Add dark mode to the email templates",
	"Profile the slow orders page",
	"Write tests for the invoice PDF export",
}

var demoFiles = map[string][]string{
	"Ledger": {"src/billing/totals.ts", "src/billing/invoice.ts", "test/billing.spec.ts"},
	"Scout":  {"docs/charting-notes.md"},
	"Atlas":  {"db/migrations/0042_orders.sql", "db/schema.prisma"},
	"Quill":  {"src/export/csv.ts", "test/export.spec.ts"},
	"Bolt":   {"test/", "ci/report.json"},
	"Pixel":  {},
	"Rune":   {"README.md"},
	"Mori":   {"docs/"},
	"Sage":   {"src/api/routes.ts", "CHANGELOG.md"},
}

var defaultFiles = []string{"src/index.ts", "src/app.ts"}

var scoutQueries = []string{
	"chart.js vs echarts bundle size", "echarts accessibility", "visx docs",
}

var defaultQueries = []string{"error handling best practice", "release notes format"}

func demoProjects(now int64) []models.Project {
	return []models.Project{
		{ID: "checkout", Name: "Checkout revamp", Color: "#FF6B9A"},
		{ID: "docs", Name: "Docs site", Color: "#48DBFB"},
		{ID: "tests", Name: "Test coverage", Color: "#FECA57"},
		{ID: "landing", Name: "Landing page", Color: "#7BED9F", Done: &models.ProjectDone{
			At:     now - 2*86_400_000 - 3*3_600_000,
			Agents: 3,
			Mins:   46,
			Cost:   2.15,
			Tasks: []string{
				"Rebuilt the hero section with the new copy",
				"Compressed every image, page now loads 40% faster",
				"Fixed 14 accessibility issues",
				"Added the pricing table",
			},
		}},
	}
}

var demoProjectOf = map[string]string{
	"Ledger": "checkout", "Atlas": "checkout", "Sage": "checkout", "Pixel": "checkout",
	"Scout": "docs", "Rune": "docs", "Mori": "docs", "Quill": "tests", "Bolt": "tests",
}

var approvals = []models.Approval{
	{
		Type: models.ApprovalFile, Title: "wants to change a file",
		Detail: models.ApprovalDetail{Path: ".env.production", Lines: []models.DiffLine{
			{Kind: "ctx", Text: "API_URL=https://api.example.com"},
			{Kind: "del", Text: "FEATURE_EXPORT=false"},
			{Kind: "add", Text: "FEATURE_EXPORT=true"},
		}},
		Risk: "This file controls production settings.", RiskLevel: models.RiskHigh,
	},
	{
		Type: models.ApprovalCommand, Title: "wants to run a command",
		Detail: models.ApprovalDetail{Cmd: "git push --force-with-lease origin feature/export"},
		Risk:   "Force pushing rewrites the remote branch.", RiskLevel: models.RiskHigh,
	},
	{
		Type: models.ApprovalCommand, Title: "wants to run a command",
		Detail: models.ApprovalDetail{Cmd: "rm -rf ./dist && npm run build"},
		Risk:   "Deletes the build folder before rebuilding.", RiskLevel: models.RiskHigh,
	},
	{
		Type: models.ApprovalCommand, Title: "wants to run a command",
		Detail: models.ApprovalDetail{Cmd: "npm install date-fns"},
		Risk:   "Adds a package to the project.", RiskLevel: models.RiskLow,
	},
	{
		Type: models.ApprovalFile, Title: "wants to change a file",
		Detail: models.ApprovalDetail{Path: "src/components/Chart.tsx", Lines: []models.DiffLine{
			{Kind: "ctx", Text: "export function Chart(props) {"},
			{Kind: "del", Text: "  const height = 200"},
			{Kind: "add", Text: "  const height = props.height ?? 240"},
		}},
		Risk: "A normal code change inside the working folder.", RiskLevel: models.RiskLow,
	},
	{
		Type: models.ApprovalCommand, Title: "wants to run a command",
		Detail: models.ApprovalDetail{Cmd: "npm run test -- --update-snapshots"},
		Risk:   "Updates test snapshots in the working folder.", RiskLevel: models.RiskLow,
	},
}

var demoApproval = models.Approval{
	Type: models.ApprovalCommand, Title: "wants to run a command",
	Detail:    models.ApprovalDetail{Cmd: "npm run db:migrate -- --env=staging"},
	Risk:      "This changes the staging database. It can be rolled back with db:rollback.",
	RiskLevel: models.RiskHigh,
}

type chatTemplate struct {
	kind   models.MessageKind
	say    string
	answer string
}

var peerTalk = []chatTemplate{
	{models.MessageQuestion, "Are you editing {fileB}? I need to change it too.",
		"Yes. Give me {etaB} and it's yours."},
	{models.MessageQuestion, "Did the tests pass on your side?",
		"Two failures in {fileB}. Fixing them now."},
	{models.MessageReview, "Can you look at my change to {fileA}?",
		"Looks good. One small thing: give the helper a clearer name."},
	{models.MessageQuestion, "Which branch should I base my work on?",
		"Use main. My last change is already merged."},
	{models.MessageQuestion, "Do you still need the staging database?",
		"Only for a few more minutes. I'll tell you when I'm done."},
	{models.MessageHandoff, "I've finished the part that touches {fileA}. Over to you for the next bit.",
		"Got it. Picking it up after my current step."},
}

var subTalk = []chatTemplate{
	{models.MessageReport, "My task is about {pct}% done.",
		"Thanks. Keep going and flag anything odd."},
	{models.MessageQuestion, "I found something strange in {fileL}. Fix it now or leave it?",
		"Leave it and write it down. I'll deal with it after this step."},
	{models.MessageReport, "Finished the first batch. Want me to keep going?",
		"Yes, please. Then write a short summary for the release notes."},
}

type seededMessage struct {
	from, to string
	kind     models.MessageKind
	text     string
	ago      int64
}

var seededMessages = []seededMessage{
	{"Ledger", "Sage", models.MessageQuestion,
		"Are you touching src/api/routes.ts? I need to change the totals call there.", 300},
	{"Sage", "Ledger", models.MessageAnswer,
		"Yes, for pagination. Give me about 5 min and it's yours.", 290},
	{"Atlas", "Atlas scribe", models.MessageHandoff,
		"Can you draft the migration notes while I prepare staging?", 240},
	{"Atlas scribe", "Atlas", models.MessageAnswer,
		"On it. I'll list every table that changes.", 235},
	{"Atlas scribe", "Atlas", models.MessageReport,
		"Notes are half done. Three tables change, one gets a new index.", 120},
	{"Atlas", "Atlas scribe", models.MessageAnswer, "Great. Add the rollback steps too.", 115},
	{"Scout", "Rune", models.MessageQuestion,
		"Did you mention the charting library in the README?", 200},
	{"Rune", "Scout", models.MessageAnswer, "Not yet. Send me your pick when you have it.", 195},
	{"Bolt", "Quill", models.MessageReview,
		"Your new export tests pass. Can you look at the two flaky ones in ci/report.json?", 80},
	{"Quill", "Bolt", models.MessageAnswer,
		"Yes, I'll take them after my helper finishes the fixtures.", 75},
}
