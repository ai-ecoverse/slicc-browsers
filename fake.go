package sliccbrowsers

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"net"
	"net/http"
	"syscall"
)

func (c Case) Transport() http.RoundTripper {
	return fakeTransport{c: c}
}

func (c Case) DialContext(_ context.Context, network, addr string) (net.Conn, error) {
	if _, ok := c.Server(addr); !ok {
		return nil, &net.OpError{Op: "dial", Net: network, Err: syscall.ECONNREFUSED}
	}
	client, server := net.Pipe()
	_ = server.Close()
	return client, nil
}

type fakeTransport struct {
	c Case
}

func (t fakeTransport) RoundTrip(req *http.Request) (*http.Response, error) {
	if req.Body != nil {
		_ = req.Body.Close()
	}
	s, ok := t.c.Server(req.URL.Host)
	if !ok {
		return nil, &net.OpError{Op: "dial", Net: "tcp", Err: syscall.ECONNREFUSED}
	}
	var body []byte
	switch req.URL.Path {
	case "/json/version":
		body = s.Version
	case "/json/list", "/json":
		body = s.List
	}
	if len(body) == 0 || string(body) == "null" {
		return response(req, http.StatusNotFound, []byte(fmt.Sprintf("Unknown command: %s", req.URL.Path))), nil
	}
	return response(req, http.StatusOK, body), nil
}

func response(req *http.Request, status int, body []byte) *http.Response {
	h := http.Header{}
	h.Set("Content-Type", "application/json; charset=UTF-8")
	if status != http.StatusOK {
		h.Set("Content-Type", "text/plain")
	}
	return &http.Response{
		Status: fmt.Sprintf("%d %s", status, http.StatusText(status)), StatusCode: status,
		Proto: "HTTP/1.1", ProtoMajor: 1, ProtoMinor: 1, Header: h,
		Body: io.NopCloser(bytes.NewReader(body)), ContentLength: int64(len(body)), Request: req,
	}
}
