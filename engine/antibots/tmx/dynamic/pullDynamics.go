package dynamic

import (
	"strings"

	"github.com/t14raptor/go-fast/parser"
)

func PullDynamicInfo(script string, domain string) (DynamicInfo, error) {
	script = extractInlineScript(script)
	ast, err := parser.ParseFile(script)

	if err != nil {
		return DynamicInfo{}, err
	}

	//decode all strings
	stringVisitor := &DeobfStringsVisitor{}
	stringVisitor.V = stringVisitor
	ast.VisitChildrenWith(stringVisitor)

	//visit assigments
	assigmentVisitor := &GetAssigmentsVisitor{
		varMap: make(map[string]string),
		domain: domain,
	}
	assigmentVisitor.V = assigmentVisitor
	ast.VisitChildrenWith(assigmentVisitor)

	//get matches via checking functions
	matchFunctionsVisitor := &FunctionsVisitor{
		varMap:      assigmentVisitor.varMap,
		DynamicInfo: DynamicInfo{},
	}
	matchFunctionsVisitor.V = matchFunctionsVisitor
	ast.VisitChildrenWith(matchFunctionsVisitor)

	return matchFunctionsVisitor.DynamicInfo, nil
}

func extractInlineScript(script string) string {
	const openTag = `<script type="text/javascript">`
	const closeTag = "</script>"

	if !strings.Contains(script, openTag) {
		return script
	}

	parts := strings.SplitN(script, openTag, 2)
	if len(parts) != 2 {
		return script
	}

	inner := strings.SplitN(parts[1], closeTag, 2)
	if len(inner) == 0 {
		return script
	}

	return inner[0]
}
