// SPDX-License-Identifier: Apache-2.0

// Package codex runs `codex app-server` as a child process and speaks its JSON-RPC protocol over
// stdio: one JSON object per line, JSON-RPC 2.0 without the "jsonrpc" field. Codex signs in with
// its own ChatGPT flow; Mabari never reads Codex's stored credentials.
package codex

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"sync"
)

// message is any line on the wire: a request, a reply or a notification.
type message struct {
	ID     *json.RawMessage `json:"id,omitempty"`
	Method string           `json:"method,omitempty"`
	Params json.RawMessage  `json:"params,omitempty"`
	Result json.RawMessage  `json:"result,omitempty"`
	Error  *rpcError        `json:"error,omitempty"`
}

type rpcError struct {
	Code    int    `json:"code"`
	Message string `json:"message"`
}

func (e *rpcError) Error() string { return fmt.Sprintf("codex: %s (%d)", e.Message, e.Code) }

// Handler gets what the server sends unasked. A request from the server, such as an approval,
// is answered by calling reply exactly once, at any time.
type Handler interface {
	Notify(method string, params json.RawMessage)
	Request(method string, params json.RawMessage, reply func(result any))
}

// Client is one connection to an app server.
type Client struct {
	in      io.Writer
	handler Handler

	mu      sync.Mutex
	next    int
	pending map[int]chan message
	closed  bool
	writeMu sync.Mutex
}

// NewClient starts reading from out. Call Close, or close out, to stop.
func NewClient(in io.Writer, out io.Reader, handler Handler) *Client {
	c := &Client{in: in, handler: handler, pending: map[int]chan message{}}
	go c.read(out)
	return c
}

// maxLine is the longest line read. Tool output can be large.
const maxLine = 16 << 20

func (c *Client) read(out io.Reader) {
	scanner := bufio.NewScanner(out)
	scanner.Buffer(make([]byte, 64<<10), maxLine)
	for scanner.Scan() {
		var m message
		if json.Unmarshal(scanner.Bytes(), &m) != nil {
			continue
		}
		switch {
		case m.Method != "" && m.ID != nil:
			id := *m.ID
			c.handler.Request(m.Method, m.Params, func(result any) { c.answer(id, result) })
		case m.Method != "":
			c.handler.Notify(m.Method, m.Params)
		case m.ID != nil:
			var id int
			if json.Unmarshal(*m.ID, &id) != nil {
				continue
			}
			c.mu.Lock()
			waiter := c.pending[id]
			delete(c.pending, id)
			c.mu.Unlock()
			if waiter != nil {
				waiter <- m
			}
		}
	}
	c.mu.Lock()
	c.closed = true
	for id, waiter := range c.pending {
		close(waiter)
		delete(c.pending, id)
	}
	c.mu.Unlock()
}

func (c *Client) write(value any) error {
	line, err := json.Marshal(value)
	if err != nil {
		return err
	}
	c.writeMu.Lock()
	defer c.writeMu.Unlock()
	_, err = c.in.Write(append(line, '\n'))
	return err
}

func (c *Client) answer(id json.RawMessage, result any) {
	data, err := json.Marshal(result)
	if err != nil {
		return
	}
	_ = c.write(message{ID: &id, Result: data})
}

// ErrClosed means the app server has gone.
var ErrClosed = errors.New("codex: the app server stopped")

// Call sends a request and waits for its reply, decoding the result into out if it isn't nil.
func (c *Client) Call(ctx context.Context, method string, params, out any) error {
	data, err := json.Marshal(params)
	if err != nil {
		return err
	}
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return ErrClosed
	}
	id := c.next
	c.next++
	waiter := make(chan message, 1)
	c.pending[id] = waiter
	c.mu.Unlock()
	raw := json.RawMessage(fmt.Sprint(id))
	if err := c.write(message{ID: &raw, Method: method, Params: data}); err != nil {
		return err
	}
	select {
	case reply, ok := <-waiter:
		if !ok {
			return ErrClosed
		}
		if reply.Error != nil {
			return reply.Error
		}
		if out != nil && len(reply.Result) > 0 {
			return json.Unmarshal(reply.Result, out)
		}
		return nil
	case <-ctx.Done():
		c.mu.Lock()
		delete(c.pending, id)
		c.mu.Unlock()
		return ctx.Err()
	}
}

// Notify sends a notification, which has no reply.
func (c *Client) Notify(method string, params any) error {
	data, err := json.Marshal(params)
	if err != nil {
		return err
	}
	return c.write(message{Method: method, Params: data})
}
