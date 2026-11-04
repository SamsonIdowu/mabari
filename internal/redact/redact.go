// SPDX-License-Identifier: Apache-2.0

// Package redact strips secrets from text before it is stored or shown.
package redact

import "regexp"

// Mask replaces a secret.
const Mask = "[redacted]"

// secretWords name a secret, for both text and JSON keys.
//
//nolint:gosec // This is a pattern of names, not a credential.
const secretWords = `api[_-]?key|token|secret|passw(?:or)?d|passphrase|pwd|private[_-]?key|credential`

var patterns = []*regexp.Regexp{
	regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY[A-Z ]*-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY[A-Z ]*-----|$)`),
	regexp.MustCompile(`\bsk-ant-[A-Za-z0-9_-]{8,}`),
	regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{16,}`),
	regexp.MustCompile(`\bmab_[A-Za-z0-9_-]{8,}`),
	regexp.MustCompile(`\bgh[pousr]_[A-Za-z0-9]{16,}`),
	regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{16,}`),
	regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`),
	regexp.MustCompile(`\bxox[abprs]-[A-Za-z0-9-]{10,}`),
	regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`),
}

// Each keeps the name and hides the value.
var (
	cookie     = regexp.MustCompile(`(?i)\b((?:set-)?cookie:\s*)[^\r\n]+`)
	header     = regexp.MustCompile(`(?i)\b(authorization:\s*(?:bearer\s+|basic\s+|token\s+)?)[^\s'"]+`)
	bearer     = regexp.MustCompile(`(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}`)
	flag       = regexp.MustCompile(`(?i)(--?[a-z0-9-]*(?:` + secretWords + `)[a-z0-9-]*\s+)("(?:[^"\\]|\\.)*"|'[^']*'|"[^\n]*|'[^\n]*|[^\s"']+)`)
	assignment = regexp.MustCompile(`(?i)\b([a-z0-9_-]*(?:` + secretWords + `)[a-z0-9_-]*["']?\s*[:=]\s*)("(?:[^"\\]|\\.)*"|'[^']*'|"[^\n]*|'[^\n]*|[^\s"'&,;]{4,})`)
	userInfo   = regexp.MustCompile(`(://[^/\s:@]*:)\S*@`)
	tokenUser  = regexp.MustCompile(`(://)[^/\s:@]{8,}@`)
	secretKey  = regexp.MustCompile(`(?i)(` + secretWords + `|authorization|cookie)`)
)

// masked hides a value, keeping any quotes around it.
func masked(value string) string {
	if len(value) >= 2 && (value[0] == '"' || value[0] == '\'') && value[len(value)-1] == value[0] {
		return value[:1] + Mask + value[:1]
	}
	return Mask
}

func maskSecondGroup(pattern *regexp.Regexp, text string) string {
	return pattern.ReplaceAllStringFunc(text, func(match string) string {
		groups := pattern.FindStringSubmatch(match)
		return groups[1] + masked(groups[2])
	})
}

// Text removes anything that looks like a secret.
func Text(text string) string {
	for _, pattern := range patterns {
		text = pattern.ReplaceAllString(text, Mask)
	}
	text = cookie.ReplaceAllString(text, "${1}"+Mask)
	text = header.ReplaceAllString(text, "${1}"+Mask)
	text = bearer.ReplaceAllString(text, "${1} "+Mask)
	text = maskSecondGroup(flag, text)
	text = maskSecondGroup(assignment, text)
	text = userInfo.ReplaceAllString(text, "${1}"+Mask+"@")
	return tokenUser.ReplaceAllString(text, "${1}"+Mask+"@")
}

// Value removes secrets from decoded JSON, however deeply nested. Values under a key that names
// a secret are hidden whatever they look like, except plain numbers and flags such as tokens_in.
func Value(value any) any {
	switch typed := value.(type) {
	case string:
		return Text(typed)
	case []any:
		clean := make([]any, len(typed))
		for index, item := range typed {
			clean[index] = Value(item)
		}
		return clean
	case map[string]any:
		clean := make(map[string]any, len(typed))
		for key, item := range typed {
			switch item.(type) {
			case float64, bool, nil:
				clean[key] = item
				continue
			}
			if secretKey.MatchString(key) {
				clean[key] = Mask
				continue
			}
			clean[key] = Value(item)
		}
		return clean
	}
	return value
}
