package analytics

type PresenceMessage struct {
	Type           string          `json:"type"`
	Timestamp      int64           `json:"timestamp"`
	BackendVersion string          `json:"backendVersion"`
	Tasks          []TaskPresence  `json:"tasks"`
}

type TaskPresence struct {
	TaskID  string         `json:"taskId"`
	RunID   string         `json:"runId"`
	Site    string         `json:"site"`
	State   int            `json:"state"`
	Status  string         `json:"status"`
	Running bool           `json:"running"`
	Inputs  map[string]any `json:"inputs,omitempty"`
}
