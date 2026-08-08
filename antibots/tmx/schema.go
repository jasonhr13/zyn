package tmx

import (
	tls_client "github.com/bogdanfinn/tls-client"
)

type TMXConfig struct {
	SessionID string
	SiteID    string
	Domain    string
	UserAgent string
	IPv4      string
	Client    tls_client.HttpClient `json:"-"`

	CurrentUrl string
	PrevUrl    string

	InitSuffix string // walmart: append to initWM url e.g. "921205550"

	SendM1M2      bool
	SendKClear    bool
	SendJF        bool
	SendPortCheck bool
	SendSig       bool

	UA     UAFields
	Device FingerprintPayload
}

type FingerprintPayload struct {
	Data FingerprintData `json:"data"`
	TZD  string
	Z    string
	C    string
}

type FingerprintData struct {
	F         string `json:"f"`
	Af        string `json:"af"`
	Sxy       string `json:"sxy"`
	Dpr       string `json:"dpr"`
	Mt        string `json:"mt"`
	Mn        int    `json:"mn"`
	Scd       int    `json:"scd"`
	Pl        int    `json:"pl"`
	Ph        string `json:"ph"`
	Nhc       int    `json:"nhc"`
	Ndm       int    `json:"ndm"`
	Nmtp      int    `json:"nmtp"`
	Mathr     string `json:"mathr"`
	P         string `json:"p"`
	UserAgent string `json:"userAgent"`
	Medh      string `json:"medh"`
	Audh      string `json:"audh"`
	Ex3       string `json:"ex3"`
	Ex4       string `json:"ex4"`
	Ex5       string `json:"ex5"`
	Uah       string `json:"uah"`
	Ual       string `json:"ual"`
	Jso       string `json:"jso"`
	Jsb       string `json:"jsb"`
	Jsou      string `json:"jsou"`
	GlC       string `json:"gl_c"`
	GlH       string `json:"gl_h"`
	Wglv      string `json:"wglv"`
	Wglr      string `json:"wglr"`
	GlhH      string `json:"glh_h"`
	Jfn       int    `json:"jfn"`
	Jfh       string `json:"jfh"`
}

type encFP struct {
	PubKeyEncoded string
	Output        string
}
