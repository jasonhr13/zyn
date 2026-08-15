package target

type ShapeHeaders struct {
	SecChUAPlatform string `json:"sec-ch-ua-platform"`
	XGyjwza5zZ      string `json:"x-gyjwza5z-z"`
	SecChUA         string `json:"sec-ch-ua"`
	XGyjwza5zF      string `json:"x-gyjwza5z-f"`
	XGyjwza5zA0     string `json:"x-gyjwza5z-a0"`
	XGyjwza5zB      string `json:"x-gyjwza5z-b"`
	XGyjwza5zA      string `json:"x-gyjwza5z-a"`
	UserAgent       string `json:"user-agent"`
	XGyjwza5zC      string `json:"x-gyjwza5z-c"`
	XGyjwza5zD      string `json:"x-gyjwza5z-d"`
}

func (h ShapeHeaders) Valid() bool {
	return h.SecChUAPlatform != "" &&
		h.XGyjwza5zZ != "" &&
		h.SecChUA != "" &&
		h.XGyjwza5zF != "" &&
		h.XGyjwza5zB != "" &&
		h.XGyjwza5zA != "" &&
		h.UserAgent != "" &&
		h.XGyjwza5zC != "" &&
		h.XGyjwza5zD != ""
}

func (t *TargetTask) shapeOK() bool {
	return t.ShapeHeaders.Valid()
}

func (t *TargetTask) shapeCookieType() string {
	if t.StepAfterSolve == "add-to-cart" {
		return "atc"
	}
	return "login"
}
