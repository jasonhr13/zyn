package constants

var Colors = ColorsStruct{
	RED:     "#fb5454",
	YELLOW:  "#FFB735",
	BLUE:    "#6DACFF",
	DEFAULT: "#868686",
	GREEN:   "#34ca6e",
}

var StatusSteps = statusStepsStuct{
	Idle:       0,
	Running:    1,
	Carted:     2,
	CheckedOut: 3,
	Declined:   4,
}
