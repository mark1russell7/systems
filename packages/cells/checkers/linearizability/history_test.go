package main

import (
	"bytes"
	"encoding/json"
	"reflect"
	"strings"
	"testing"
)

const sequential = `
{"client":0,"op":"put","key":"x","value":"1","call":0,"return":10,"result":"ok"}
{"client":1,"op":"get","key":"x","value":"1","call":20,"return":30,"result":"ok"}
`

const stale = `
{"client":0,"op":"put","key":"x","value":"1","call":0,"return":10,"result":"ok"}
{"client":0,"op":"put","key":"x","value":"2","call":20,"return":30,"result":"ok"}
{"client":1,"op":"get","key":"x","value":"1","call":40,"return":50,"result":"ok"}
`

const overlap = `
{"client":0,"op":"put","key":"x","value":"1","call":0,"return":10,"result":"ok"}
{"client":0,"op":"put","key":"x","value":"2","call":20,"return":30,"result":"ok"}
{"client":1,"op":"get","key":"x","value":"1","call":25,"return":35,"result":"ok"}
`

const touching = `
{"client":0,"op":"put","key":"x","value":"1","call":0,"return":10,"result":"ok"}
{"client":0,"op":"put","key":"x","value":"2","call":20,"return":30,"result":"ok"}
{"client":1,"op":"get","key":"x","value":"1","call":30,"return":40,"result":"ok"}
`

const empty = `
{"client":1,"op":"get","key":"x","value":null,"call":0,"return":10,"result":"ok"}
{"client":0,"op":"put","key":"x","value":"1","call":20,"return":30,"result":"ok"}
`

const unknownSeen = `
{"client":0,"op":"put","key":"x","value":"1","call":0,"return":10,"result":"ok"}
{"client":2,"op":"put","key":"x","value":"2","call":20,"result":"unknown"}
{"client":1,"op":"get","key":"x","value":"2","call":40,"return":50,"result":"ok"}
`

const unknownUnseen = `
{"client":0,"op":"put","key":"x","value":"1","call":0,"return":10,"result":"ok"}
{"client":2,"op":"put","key":"x","value":"2","call":20,"result":"unknown"}
{"client":1,"op":"get","key":"x","value":"1","call":40,"return":50,"result":"ok"}
`

const unknownBack = `
{"client":0,"op":"put","key":"x","value":"1","call":0,"return":10,"result":"ok"}
{"client":2,"op":"put","key":"x","value":"2","call":20,"result":"unknown"}
{"client":1,"op":"get","key":"x","value":"2","call":40,"return":50,"result":"ok"}
{"client":1,"op":"get","key":"x","value":"1","call":60,"return":70,"result":"ok"}
`

const failed = `
{"client":0,"op":"put","key":"x","value":"9","call":0,"return":10,"result":"fail"}
{"client":1,"op":"get","key":"x","value":"9","call":20,"return":30,"result":"ok"}
`

const deleted = `
{"client":0,"op":"put","key":"x","value":"1","call":0,"return":10,"result":"ok"}
{"client":0,"op":"delete","key":"x","call":20,"return":30,"result":"ok"}
{"client":1,"op":"get","key":"x","value":null,"call":40,"return":50,"result":"ok"}
`

const deletedBack = `
{"client":0,"op":"put","key":"x","value":"1","call":0,"return":10,"result":"ok"}
{"client":0,"op":"delete","key":"x","call":20,"return":30,"result":"ok"}
{"client":1,"op":"get","key":"x","value":"1","call":40,"return":50,"result":"ok"}
`

const twoKeys = `
{"client":0,"op":"put","key":"x","value":"1","call":0,"return":10,"result":"ok"}
{"client":0,"op":"put","key":"y","value":"1","call":0,"return":10,"result":"ok"}
{"client":0,"op":"put","key":"y","value":"2","call":20,"return":30,"result":"ok"}
{"client":1,"op":"get","key":"x","value":"1","call":40,"return":50,"result":"ok"}
{"client":1,"op":"get","key":"y","value":"1","call":40,"return":50,"result":"ok"}
{"client":1,"op":"get","key":"y","value":null,"call":60,"result":"unknown"}
`

var cases = []struct {
	name    string
	history string
	result  string
	illegal []string
}{
	{"a get after a put reads it", sequential, "Ok", []string{}},
	{"a get after a newer put reads the old value: the stale read", stale, "Illegal", []string{"x"}},
	{"a get that overlaps the newer put can read the old value", overlap, "Ok", []string{}},
	{"an interval is closed: a get from the return of the put can come first", touching, "Ok", []string{}},
	{"a get before the first put reads no value", empty, "Ok", []string{}},
	{"an unknown put can take effect", unknownSeen, "Ok", []string{}},
	{"an unknown put can have no effect", unknownUnseen, "Ok", []string{}},
	{"a value cannot come back after the unknown put took effect", unknownBack, "Illegal", []string{"x"}},
	{"a failed put has no effect", failed, "Illegal", []string{"x"}},
	{"a get after a delete reads no value", deleted, "Ok", []string{}},
	{"a get after a delete cannot read the old value", deletedBack, "Illegal", []string{"x"}},
	{"each key is checked apart, and only the stale key is illegal", twoKeys, "Illegal", []string{"y"}},
}

func TestCheck(t *testing.T) {
	for _, each := range cases {
		t.Run(each.name, func(t *testing.T) {
			history, err := Parse(strings.NewReader(each.history))
			if err != nil {
				t.Fatalf("parse: %v", err)
			}
			verdict := Check(history, 0)
			if verdict.Result != each.result {
				t.Errorf("result %s, want %s", verdict.Result, each.result)
			}
			if !reflect.DeepEqual(verdict.Illegal, each.illegal) {
				t.Errorf("illegal %v, want %v", verdict.Illegal, each.illegal)
			}
		})
	}
}

func TestCounts(t *testing.T) {
	history, err := Parse(strings.NewReader(twoKeys + failed + unknownSeen))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	verdict := Check(history, 0)
	if verdict.Operations != 9 || verdict.Keys != 2 || verdict.Dropped != 2 || verdict.Unknown != 1 {
		t.Errorf("counts %+v, want 9 operations with the unknown one, 2 keys, 2 dropped and 1 unknown", verdict)
	}
}

func TestRefusals(t *testing.T) {
	refused := map[string]string{
		"no client":         `{"op":"get","key":"x","value":null,"call":0,"return":1,"result":"ok"}`,
		"a negative client": `{"client":-1,"op":"get","key":"x","value":null,"call":0,"return":1,"result":"ok"}`,
		"no key":            `{"client":0,"op":"get","value":null,"call":0,"return":1,"result":"ok"}`,
		"no call":           `{"client":0,"op":"get","key":"x","value":null,"return":1,"result":"ok"}`,
		"no return":         `{"client":0,"op":"get","key":"x","value":null,"call":0,"result":"ok"}`,
		"a return first":    `{"client":0,"op":"get","key":"x","value":null,"call":5,"return":1,"result":"ok"}`,
		"a put of nothing":  `{"client":0,"op":"put","key":"x","call":0,"return":1,"result":"ok"}`,
		"a delete of value": `{"client":0,"op":"delete","key":"x","value":"1","call":0,"return":1,"result":"ok"}`,
		"another op":        `{"client":0,"op":"cas","key":"x","value":"1","call":0,"return":1,"result":"ok"}`,
		"another result":    `{"client":0,"op":"get","key":"x","value":null,"call":0,"return":1,"result":"maybe"}`,
		"an unknown return": `{"client":0,"op":"put","key":"x","value":"1","call":0,"return":1,"result":"unknown"}`,
		"another field":     `{"client":0,"op":"get","key":"x","value":null,"call":0,"return":1,"result":"ok","node":2}`,
		"no JSON":           `get x`,
	}
	for name, line := range refused {
		if _, err := Parse(strings.NewReader(line)); err == nil {
			t.Errorf("%s: no error", name)
		}
	}
}

func TestRun(t *testing.T) {
	for _, each := range []struct {
		history string
		code    int
		result  string
	}{{sequential, 0, "Ok"}, {stale, 1, "Illegal"}} {
		var stdout, stderr bytes.Buffer
		code := run(nil, strings.NewReader(each.history), &stdout, &stderr)
		if code != each.code {
			t.Errorf("exit %d, want %d (%s)", code, each.code, stderr.String())
		}
		var verdict Verdict
		if err := json.Unmarshal(stdout.Bytes(), &verdict); err != nil {
			t.Fatalf("output %q: %v", stdout.String(), err)
		}
		if verdict.Ev != "checked" || verdict.Result != each.result {
			t.Errorf("verdict %+v, want the result %s", verdict, each.result)
		}
	}
	var stdout, stderr bytes.Buffer
	if code := run(nil, strings.NewReader(`{"client":0}`), &stdout, &stderr); code != 2 || stdout.Len() != 0 {
		t.Errorf("a refused history: exit %d, output %q", code, stdout.String())
	}
	if code := run([]string{"extra"}, strings.NewReader(sequential), &stdout, &stderr); code != 2 {
		t.Errorf("an operand: exit %d, want 2", code)
	}
}
