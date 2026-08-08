package constants

import "strings"

var StateCodes = map[string]string{
	"AL": "Alabama",
	"AK": "Alaska",
	"AZ": "Arizona",
	"AR": "Arkansas",
	"CA": "California",
	"CO": "Colorado",
	"CT": "Connecticut",
	"DE": "Delaware",
	"FL": "Florida",
	"GA": "Georgia",
	"HI": "Hawaii",
	"ID": "Idaho",
	"IL": "Illinois",
	"IN": "Indiana",
	"IA": "Iowa",
	"KS": "Kansas",
	"KY": "Kentucky",
	"LA": "Louisiana",
	"ME": "Maine",
	"MD": "Maryland",
	"MA": "Massachusetts",
	"MI": "Michigan",
	"MN": "Minnesota",
	"MS": "Mississippi",
	"MO": "Missouri",
	"MT": "Montana",
	"NE": "Nebraska",
	"NV": "Nevada",
	"NH": "New Hampshire",
	"NJ": "New Jersey",
	"NM": "New Mexico",
	"NY": "New York",
	"NC": "North Carolina",
	"ND": "North Dakota",
	"OH": "Ohio",
	"OK": "Oklahoma",
	"OR": "Oregon",
	"PA": "Pennsylvania",
	"RI": "Rhode Island",
	"SC": "South Carolina",
	"SD": "South Dakota",
	"TN": "Tennessee",
	"TX": "Texas",
	"UT": "Utah",
	"VT": "Vermont",
	"VA": "Virginia",
	"WA": "Washington",
	"WV": "West Virginia",
	"WI": "Wisconsin",
	"WY": "Wyoming",
	// Territories
	"AS": "American Samoa",
	"DC": "District of Columbia",
	"FM": "Federated States of Micronesia",
	"GU": "Guam",
	"MH": "Marshall Islands",
	"MP": "Northern Mariana Islands",
	"PW": "Palau",
	"PR": "Puerto Rico",
	"VI": "Virgin Islands",
	// Armed Forces (AE includes Europe, Africa, Canada, and the Middle East)
	"AA": "Armed Forces Americas",
	"AE": "Armed Forces Europe",
	"AP": "Armed Forces Pacific",
	// Canadian states
	"BC": "British Columbia",
	"ON": "Ontario",
	"NL": "Newfoundland and Labrador",
	"NS": "Nova Scotia",
	"PE": "Prince Edward Island",
	"NB": "New Brunswick",
	"QC": "Quebec",
	"MB": "Manitoba",
	"SK": "Saskatchewan",
	"AB": "Alberta",
	"NT": "Northwest Territories",
	"NU": "Nunavut",
	"YT": "Yukon Territory",
}

var CountryCodes = map[string]string{
	"US": "United States",
	"CA": "Canada",
}

var CountryToCode = map[string]string{
	"United States": "US",
	"Canada":        "CA",
}

var StateToCode = map[string]string{
	"California":                     "CA",
	"Hawaii":                         "HI",
	"Indiana":                        "IN",
	"Virginia":                       "VA",
	"Armed Forces Americas":          "AA",
	"Florida":                        "FL",
	"District of Columbia":           "DC",
	"New Mexico":                     "NM",
	"Rhode Island":                   "RI",
	"South Carolina":                 "SC",
	"Connecticut":                    "CT",
	"Illinois":                       "IL",
	"Louisiana":                      "LA",
	"Mississippi":                    "MS",
	"Virgin Islands":                 "VI",
	"New Jersey":                     "NJ",
	"Wyoming":                        "WY",
	"Armed Forces Europe":            "AE",
	"Arizona":                        "AZ",
	"North Dakota":                   "ND",
	"Tennessee":                      "TN",
	"Texas":                          "TX",
	"Washington":                     "WA",
	"Guam":                           "GU",
	"Northern Mariana Islands":       "MP",
	"Georgia":                        "GA",
	"Massachusetts":                  "MA",
	"Missouri":                       "MO",
	"Nebraska":                       "NE",
	"New York":                       "NY",
	"Nevada":                         "NV",
	"Wisconsin":                      "WI",
	"Armed Forces Pacific":           "AP",
	"Montana":                        "MT",
	"Palau":                          "PW",
	"Arkansas":                       "AR",
	"Colorado":                       "CO",
	"United States":                  "US",
	"Kansas":                         "KS",
	"Kentucky":                       "KY",
	"Maine":                          "ME",
	"North Carolina":                 "NC",
	"Federated States of Micronesia": "FM",
	"Delaware":                       "DE",
	"Maryland":                       "MD",
	"New Hampshire":                  "NH",
	"Utah":                           "UT",
	"Alabama":                        "AL",
	"Michigan":                       "MI",
	"Ohio":                           "OH",
	"South Dakota":                   "SD",
	"Alaska":                         "AK",
	"Idaho":                          "ID",
	"Iowa":                           "IA",
	"Oklahoma":                       "OK",
	"Puerto Rico":                    "PR",
	"Minnesota":                      "MN",
	"Oregon":                         "OR",
	"Pennsylvania":                   "PA",
	"American Samoa":                 "AS",
	"Marshall Islands":               "MH",
	"Vermont":                        "VT",
	"West Virginia":                  "WV",
	// Canadian states
	"British Columbia":          "BC",
	"Ontario":                   "ON",
	"Newfoundland and Labrador": "NL",
	"Nova Scotia":               "NS",
	"Prince Edward Island":      "PE",
	"New Brunswick":             "NB",
	"Quebec":                    "QC",
	"Manitoba":                  "MB",
	"Saskatchewan":              "SK",
	"Alberta":                   "AB",
	"Northwest Territories":     "NT",
	"Nunavut":                   "NU",
	"Yukon Territory":           "YT",
}

func NormalizeStateCode(state string) string {
	state = strings.TrimSpace(state)
	if state == "" {
		return ""
	}
	upper := strings.ToUpper(state)
	if _, ok := StateCodes[upper]; ok {
		return upper
	}
	if code, ok := StateToCode[state]; ok {
		return code
	}
	return state
}

// CountryToISO3 maps a normalized 2-letter country code to its ISO 3166-1 alpha-3 equivalent.
var CountryToISO3 = map[string]string{
	"US": "USA",
	"CA": "CAN",
}

// NormalizeCountryCode resolves a profile's country (either a 2-letter code or a full name) to
// its ISO 3166-1 alpha-2 code, e.g. "Canada" or "ca" -> "CA".
func NormalizeCountryCode(country string) string {
	country = strings.TrimSpace(country)
	if country == "" {
		return ""
	}
	upper := strings.ToUpper(country)
	if _, ok := CountryCodes[upper]; ok {
		return upper
	}
	if code, ok := CountryToCode[country]; ok {
		return code
	}
	return upper
}

// NormalizeCountryCodeISO3 resolves a profile's country to its ISO 3166-1 alpha-3 code,
// e.g. "Canada" or "CA" -> "CAN". Falls back to the alpha-2 code if no alpha-3 mapping exists.
func NormalizeCountryCodeISO3(country string) string {
	code := NormalizeCountryCode(country)
	if iso3, ok := CountryToISO3[code]; ok {
		return iso3
	}
	return code
}
