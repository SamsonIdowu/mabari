// SPDX-License-Identifier: Apache-2.0

package events

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/models"
	"github.com/SamsonIdowu/mabari/internal/redact"
)

// Masking runs inside Do at about a third of a millisecond a kilobyte, and every agent waits while
// it does, so nothing unbounded may reach it. A session can send a line of tens of megabytes.
const (
	// maskLimit is the most tool data that is masked. Longer JSON isn't kept at all, because part
	// of it can't be decoded, and text patterns can't be trusted with it.
	maskLimit = 256 << 10
	// maskMargin is how much is masked past the limit and then dropped. Cutting first can leave
	// half a secret at the cut, too short to match, so the cut itself is never kept.
	maskMargin = 1 << 10
)

// maskText masks text and cuts it down to limit characters, reporting whether anything was cut.
func maskText(text string, limit int) (string, bool) {
	cut := charsEnd(text, limit+maskMargin)
	if cut == len(text) {
		return redact.Text(text), false
	}
	masked := []rune(redact.Text(text[:cut]))
	return string(masked[:max(0, min(limit, len(masked)-maskMargin))]), true
}

// charsEnd is where the first count characters of text end.
func charsEnd(text string, count int) int {
	for offset := range text {
		if count == 0 {
			return offset
		}
		count--
	}
	return len(text)
}

// maskData masks a tool's input or output, reporting whether anything was lost.
func maskData(text string) (string, bool) {
	if len(text) <= maskLimit {
		return maskStructured(text), false
	}
	opening := strings.TrimSpace(text[:64])
	if opening != "" && (opening[0] == '{' || opening[0] == '[') {
		return "", true
	}
	return maskText(text, models.ConversationToolLimit)
}

// maskStructured removes secrets from a tool's input or output, which is usually JSON. Text
// patterns can't be trusted there: quotes come between a key and its value, so "Authorization: x"
// never matches "Authorization":"x", and a value's quotes are escaped. So JSON is decoded and
// masked by its keys, and only text that isn't JSON is treated as text.
//
// Data with nothing to hide comes back as it came, formatting and all, so what a person reads is
// what ran. Masked data stays JSON. Numbers stay as they were written, which also means a number
// under a key that names a secret is masked, where redact.Value alone would leave a float64.
func maskStructured(text string) string {
	value, ok := parseStructured(text)
	if !ok {
		return redact.Text(text)
	}
	clean := redact.Value(maskEmbedded(value))
	if reflect.DeepEqual(value, clean) {
		// redact.Value reads values, so a secret used as a key is still left for this to find.
		return redact.Text(text)
	}
	return redact.Text(encodeJSON(clean))
}

// parseStructured decodes text that is wholly one JSON object or array. Anything after it means
// it isn't, or what followed would never be looked at.
func parseStructured(text string) (any, bool) {
	trimmed := strings.TrimSpace(text)
	if trimmed == "" || (trimmed[0] != '{' && trimmed[0] != '[') {
		return nil, false
	}
	decoder := json.NewDecoder(strings.NewReader(trimmed))
	decoder.UseNumber()
	var value any
	if decoder.Decode(&value) != nil {
		return nil, false
	}
	if _, err := decoder.Token(); !errors.Is(err, io.EOF) {
		return nil, false
	}
	return value, true
}

// maskEmbedded masks JSON held inside strings, such as a request body passed as one field, whose
// keys redact.Value would otherwise see only as text.
func maskEmbedded(value any) any {
	switch typed := value.(type) {
	case string:
		if _, ok := parseStructured(typed); ok {
			return maskStructured(typed)
		}
		return typed
	case []any:
		masked := make([]any, len(typed))
		for index, item := range typed {
			masked[index] = maskEmbedded(item)
		}
		return masked
	case map[string]any:
		masked := make(map[string]any, len(typed))
		for key, item := range typed {
			masked[key] = maskEmbedded(item)
		}
		return masked
	}
	return value
}

// encodeJSON writes decoded JSON back without escaping characters such as & for a web page, since
// the page shows this as text.
func encodeJSON(value any) string {
	var out bytes.Buffer
	encoder := json.NewEncoder(&out)
	encoder.SetEscapeHTML(false)
	// Decoded JSON always encodes.
	_ = encoder.Encode(value)
	return strings.TrimSuffix(out.String(), "\n")
}
