package constants

type ColorsStruct struct {
	RED     string
	YELLOW  string
	PURPLE  string
	BLUE    string
	GREEN   string
	DEFAULT string
}

type statusStepsStuct struct {
	Error      int
	Idle       int
	Running    int
	Carted     int
	CheckedOut int
	Declined   int
}
