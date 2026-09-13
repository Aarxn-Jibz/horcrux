// Package webrtc defines the data-channel envelope used for opaque object operations.
package webrtc

import "encoding/json"

const MaxChunkBytes = 64 * 1024

type Control struct {
	Type       string `json:"type"`
	Capability string `json:"capability,omitempty"`
	ObjectID   string `json:"objectId,omitempty"`
	Size       int64  `json:"size,omitempty"`
	Checksum   string `json:"checksum,omitempty"`
}

func ParseControl(raw []byte) (Control, error) {
	var control Control
	err := json.Unmarshal(raw, &control)
	return control, err
}

func (control Control) Bytes() ([]byte, error) { return json.Marshal(control) }
