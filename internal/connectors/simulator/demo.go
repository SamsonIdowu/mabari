// SPDX-License-Identifier: Apache-2.0

package simulator

import (
	"github.com/SamsonIdowu/mabari/internal/models"
)

// The demo office's data, copied from design/mabari-prototype.html.

var plan = []models.AgentState{
	models.StateThinking, models.StateReading, models.StateEditing, models.StateRunning,
	models.StateEditing, models.StateBrowsing, models.StateThinking, models.StateEditing,
}

var skins = []string{"#F2C9A0", "#D9A27A", "#B07850", "#8C5A3A", "#6B4128", "#E8B98F"}

var hairs = []string{
	"#2A1B12", "#5A3A22", "#101010", "#B5651D", "#D9C27A", "#6B4E3A", "#2A2A2E",
}

// hues must stay in step with identityHues in web/src/shared/tokens.ts.
var hues = []string{
	"#FF6B9A", "#5CE1E6", "#FFB547", "#FFB8A0", "#4FB3FF", "#B5E35B", "#FF8A5B", "#FF8FCF",
	"#3FD07F", "#FFD84D", "#7FA8FF", "#FF6F61", "#2DE1C2", "#F8A5C2",
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
