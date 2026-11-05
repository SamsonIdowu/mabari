// SPDX-License-Identifier: Apache-2.0

package server

import (
	"errors"
	"net/http"

	"github.com/SamsonIdowu/mabari/internal/events"
	"github.com/SamsonIdowu/mabari/internal/models"
)

type answerBody struct {
	QuestionID string                  `json:"questionId"`
	Answers    []models.QuestionAnswer `json:"answers"`
}

// answerQuestion passes the person's answers to the question an agent is asking. It answers only
// that agent's question with that id, and only with answers that fit it.
func (a *api) answerQuestion(w http.ResponseWriter, r *http.Request) {
	var body answerBody
	if !readJSON(w, r, &body) {
		return
	}
	if body.QuestionID == "" || len(body.Answers) == 0 || len(body.Answers) > models.QuestionsMax {
		writeError(w, http.StatusBadRequest, "send the question's id and an answer for each question")
		return
	}
	for _, answer := range body.Answers {
		if len(answer.Picked) > models.QuestionOptionsMax {
			writeError(w, http.StatusBadRequest, "an answer picks more options than a question has")
			return
		}
	}
	var (
		found  bool
		failed error
	)
	err := a.engine.Do(func() {
		if found = a.engine.Agent(r.PathValue("id")) != nil; found {
			failed = a.engine.AnswerQuestion(r.PathValue("id"), body.QuestionID, body.Answers)
		}
	})
	switch {
	case err != nil:
		internalError(w, err)
	case !found:
		writeError(w, http.StatusNotFound, "no such agent")
	case errors.Is(failed, events.ErrNoQuestion):
		// Another tab may have answered first, or the agent stopped waiting.
		writeError(w, http.StatusConflict, failed.Error())
	case failed != nil:
		writeError(w, http.StatusBadRequest, failed.Error())
	default:
		writeJSON(w, http.StatusOK, map[string]bool{"answered": true})
	}
}
