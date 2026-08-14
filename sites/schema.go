package sites

type TaskInput struct {
	Id              string `json:"id"`
	TaskGroup       string `json:"taskGroup"`
	MonitorDelay    int    `json:"monitorDelay"`
	RetryDelay      int    `json:"retryDelay"`
	Proxy           string `json:"proxy"`
	ProfileId       string `json:"profileId"`
	SiteName        string `json:"siteName"`
	Item            string `json:"item"`
	Status          string `json:"status"`
	Site            string `json:"site"`
	Mode            string `json:"mode"`
	MinPrice        float64 `json:"minPrice"`
	MaxPrice        float64 `json:"maxPrice"`
	Items           []Item  `json:"items"`
	MonitorItems    []Item  `json:"monitorItems"`
	Account         string `json:"account"`
	AccountID       string `json:"AccountId"`
	LoopCheckout    bool   `json:"loopCheckout"`
	WaitForQueue    bool   `json:"waitForQueue"`
	QueueEntryDelay int    `json:"queueEntryDelay"`
	AllInstock      bool   `json:"allInstock"`
	Endless         bool   `json:"endless"`
	UseFillerItem   bool   `json:"useFillerItem"`
	UseOtpLogin     bool   `json:"useOtpLogin"`

	IgnoreLowStock bool `json:"ignoreLowStock"`
}

type Item struct {
	MonitorInput string   `json:"monitorInput"`
	Quantity     int      `json:"quantity"`
	MaxPrice     float64  `json:"maxPrice"`
	Color        string   `json:"color"`
	Size         []string `json:"size"`
	Priority     bool     `json:"priority,omitempty"`
}

type Input struct {
	Input           string   `json:"input"`
	Sizes           []string `json:"sizes"`
	Quantity        int      `json:"quantity"`
	MaxPrice        float64  `json:"maxPrice"`
	ProductLink     bool     `json:"productLink"`
	ProductFound    bool     `json:"productFound"`
	IncludeKeywords []string `json:"includeKeywords"`
	ExcludeKeywords []string `json:"excludeKeywords"`
	Sku             string   `json:"sku"`
	Found           bool     `json:"found"`
	Priority        bool     `json:"priority,omitempty"`
}
