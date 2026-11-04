// SPDX-License-Identifier: Apache-2.0

// Package redact strips secrets from text before it is stored or shown.
package redact

import (
	"regexp"
	"strings"
)

// Mask replaces a secret.
const Mask = "[redacted]"

var patterns = []*regexp.Regexp{
	regexp.MustCompile(`-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z ]*PRIVATE KEY-----|$)`),
	regexp.MustCompile(`\bsk-ant-[A-Za-z0-9_-]{8,}`),
	regexp.MustCompile(`\bsk-[A-Za-z0-9_-]{16,}`),
	regexp.MustCompile(`\bvju_[A-Za-z0-9_-]{8,}`),
	regexp.MustCompile(`\bgh[pousr]_[A-Za-z0-9]{16,}`),
	regexp.MustCompile(`\bgithub_pat_[A-Za-z0-9_]{16,}`),
	regexp.MustCompile(`\bAKIA[0-9A-Z]{16}\b`),
	regexp.MustCompile(`\bxox[abprs]-[A-Za-z0-9-]{10,}`),
	regexp.MustCompile(`\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}`),
}

// Keeps the name and hides the value, in `TOKEN=abc`, `"password": "abc"` and `Bearer abc`.
var (
	assignment = regexp.MustCompile(`(?i)\b([a-z0-9_-]*(?:api[_-]?key|token|secret|passw(?:or)?d|pwd)[a-z0-9_-]*"?'?\s*[:=]\s*"?'?)([^\s"'&,;]{4,})`)
	bearer     = regexp.MustCompile(`(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}`)
	userInfo   = regexp.MustCompile(`(://[^/\s:@]+:)[^/\s@]+@`)
)

// Text removes anything that looks like a secret.
func Text(text string) string {
	for _, pattern := range patterns {
		text = pattern.ReplaceAllString(text, Mask)
	}
	text = assignment.ReplaceAllStringFunc(text, func(match string) string {
		groups := assignment.FindStringSubmatch(match)
		if strings.Contains(groups[2], Mask) {
			return match
		}
		return groups[1] + Mask
	})
	text = bearer.ReplaceAllString(text, "${1} "+Mask)
	return userInfo.ReplaceAllString(text, "${1}"+Mask+"@")
}

// Value removes secrets from decoded JSON, however deeply nested. Values under a key that names
// a secret are hidden whatever they look like.
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

var secretKey = regexp.MustCompile(`(?i)(api[_-]?key|token|secret|passw(or)?d|authorization|cookie)`)
