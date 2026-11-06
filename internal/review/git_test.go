// SPDX-License-Identifier: Apache-2.0
package review

import (
	"strings"
	"testing"
)

func TestGitIsGivenNoneOfMabarisKeys(t *testing.T) {
	t.Setenv("MABARI_MASTER_KEY", "a-key-git-must-not-see")
	for _, entry := range environment() {
		if strings.HasPrefix(entry, "MABARI_") {
			t.Errorf("git would see %s", entry)
		}
	}
}
