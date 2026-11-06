-- SPDX-License-Identifier: Apache-2.0
-- Marks the log rows the demo's agents wrote, so ending the demo takes those away and nothing else.
ALTER TABLE activity_log ADD COLUMN demo INTEGER NOT NULL DEFAULT 0;
