// SPDX-License-Identifier: Apache-2.0

package planner

import (
	"strings"
	"testing"

	"github.com/SamsonIdowu/mabari/internal/models"
)

func roles(plan Plan) string {
	var out []string
	for _, member := range plan.Members {
		out = append(out, string(member.Role))
	}
	return strings.Join(out, ",")
}

var claudeOffice = Office{Connected: map[models.AccountKind]bool{models.AccountClaudeCode: true}}

func TestTheExamplesGiveThePrototypesTeams(t *testing.T) {
	cases := []struct {
		brief, name, roles string
		minutes            int
	}{
		{Examples[0], "Landing Page Coffee", "build,test", 65},
		{Examples[1], "Competitors Report Their", "research,write", 40},
		{Examples[2], "Internal Dashboard Shows", "build,data", 65},
		{"", "New Project", "build,test", 65},
	}
	for _, tc := range cases {
		plan := Make(tc.brief, tc.brief, nil, claudeOffice)
		if plan.Name != tc.name || roles(plan) != tc.roles || plan.Minutes != tc.minutes {
			t.Errorf("%q = %q %s %d min", tc.brief, plan.Name, roles(plan), plan.Minutes)
		}
	}
}

func TestFollowUpsChangeThePlan(t *testing.T) {
	first := Make(Examples[0], Examples[0], nil, claudeOffice)
	if first.LeadName != "Juniper" || first.Members[0].Name != "Orion" || first.Account != models.AccountClaudeCode {
		t.Fatalf("first = %+v", first)
	}
	all := Examples[0] + ". no tests, call it Bean counter. use codex"
	second := Make(all, "no tests, call it Bean counter. use codex", &first, claudeOffice)
	if second.Name != "Bean counter" || strings.Contains(roles(second), "test") || second.Account != models.AccountCodex ||
		second.LeadName != "Juniper" || second.Members[0].Name != "Orion" || second.Color != first.Color {
		t.Errorf("second = %+v", second)
	}
	if second.LeadModel != "gpt-5-codex" || second.SubModel != "gpt-5-mini" {
		t.Errorf("models = %s %s", second.LeadModel, second.SubModel)
	}
}

// The prototype only drops a role when its first four letters appear, so "no docs" keeps the
// writer. The port keeps that, so the same words give the same team.
func TestRemovalsMatchThePrototypeExactly(t *testing.T) {
	plan := Make("write the docs, no docs", "", nil, claudeOffice)
	if roles(plan) != "write" {
		t.Errorf("roles = %s", roles(plan))
	}
	plan = Make("build an app without the research", "", nil, claudeOffice)
	if roles(plan) != "build" {
		t.Errorf("roles = %s", roles(plan))
	}
}

func TestUntickedMembersChangeTheEstimate(t *testing.T) {
	plan := Make(Examples[0], "", nil, claudeOffice)
	for index := range plan.Members {
		plan.Members[index].On = plan.Members[index].Role != RoleBuild
	}
	if Minutes(plan) != 45 {
		t.Errorf("without the builder = %d", Minutes(plan))
	}
	for index := range plan.Members {
		plan.Members[index].On = false
	}
	if Minutes(plan) != 40 {
		t.Errorf("lead alone = %d", Minutes(plan))
	}
}

func TestNamesSkipAgentsInTheOffice(t *testing.T) {
	office := claudeOffice
	office.Taken = func(name string) bool { return name == "Juniper" || name == "Orion" }
	plan := Make("build it", "", nil, office)
	if plan.LeadName != "Maple" || plan.Members[0].Name != "Nova" {
		t.Errorf("names = %s, %s", plan.LeadName, plan.Members[0].Name)
	}
}

func TestTheAccountFollowsWhatIsConnected(t *testing.T) {
	codexOnly := Office{Connected: map[models.AccountKind]bool{models.AccountCodex: true}}
	if got := Make("build", "", nil, codexOnly).Account; got != models.AccountCodex {
		t.Errorf("codex only = %s", got)
	}
	keyOnly := Office{Connected: map[models.AccountKind]bool{models.AccountOpenAIKey: true}}
	if got := Make("build", "use gpt", nil, keyOnly).Account; got != models.AccountOpenAIKey {
		t.Errorf("openai key = %s", got)
	}
	defaults := Office{Defaults: map[string]string{"claude": "claude-opus-5-5"}}
	if got := Make("build", "", nil, defaults).LeadModel; got != "claude-opus-5-5" {
		t.Errorf("default model = %s", got)
	}
}

func TestReplyWording(t *testing.T) {
	plan := Make(Examples[1], "", nil, claudeOffice)
	want := "I read 2 files and your instructions. Here's a team for it. Juniper leads and splits the work, " +
		"and 2 subagents sit in Juniper's office. Untick anyone you don't need, or tell me what to change."
	if got := Reply(plan, true, []string{"2 files", "your instructions"}); got != want {
		t.Errorf("reply = %q", got)
	}
	plan.Members[1].On = false
	if got := Reply(plan, false, nil); !strings.HasPrefix(got, "Updated. Juniper") || !strings.Contains(got, "1 subagent sits") {
		t.Errorf("reply = %q", got)
	}
}
