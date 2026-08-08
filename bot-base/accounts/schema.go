package accounts

type Account struct {
	AccountGroup string `json:"accountGroup"`
	Id           string `json:"id"`
	Password     string `json:"password"`
	Type         string `json:"type"`
	Username     string `json:"username"`
	Cookie       string `json:"cookie"`
}
