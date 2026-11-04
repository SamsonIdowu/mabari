// SPDX-License-Identifier: Apache-2.0

//go:build !embedweb

// Package web holds the React app. Release builds embed web/dist with the embedweb tag, so
// `go test` and the dev server work before the web app has been built.
package web

import "io/fs"

// Files returns the built web app, or nil if this binary was built without it.
func Files() fs.FS { return nil }
