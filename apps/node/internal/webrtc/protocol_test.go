package webrtc

import "testing"

func TestControlRoundTrip(t *testing.T) {
	raw, err := (Control{Type: "put-init", Capability: "signed", ObjectID: "file/shard/object", Size: 42}).Bytes()
	if err != nil { t.Fatal(err) }
	parsed, err := ParseControl(raw)
	if err != nil || parsed.Type != "put-init" || parsed.ObjectID != "file/shard/object" { t.Fatalf("unexpected control %#v: %v", parsed, err) }
}
