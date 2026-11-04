// SPDX-License-Identifier: Apache-2.0

//go:build embedweb

package web

import (
	"embed"
	"io/fs"
)

//go:embed all:dist
var dist embed.FS

// Files returns the built web app, or nil if this binary was built without it.
func Files() fs.FS {
	files, err := fs.Sub(dist, "dist")
	if err != nil {
		panic(err) // Only possible if the embed pattern above is wrong.
	}
	return files
}
