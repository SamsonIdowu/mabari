// SPDX-License-Identifier: Apache-2.0

package events

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"reflect"
	"strings"

	"github.com/SamsonIdowu/mabari/internal/redact"
)

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
