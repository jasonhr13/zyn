package dynamic

import (
	"strings"

	"github.com/t14raptor/go-fast/ast"
)

type GetAssigmentsVisitor struct {
	ast.NoopVisitor
	varMap map[string]string
	domain string
}

func (t *GetAssigmentsVisitor) VisitAssignExpression(n *ast.AssignExpression) {
	n.VisitChildrenWith(t)

	//check left side
	varName := ""
	if leftMemExpr, ok := n.Left.Expr.(*ast.MemberExpression); ok {
		if memProp, ok := leftMemExpr.Property.Prop.(*ast.Identifier); ok && isTDName(memProp.Name) {
			varName = memProp.Name
		}
	}

	if leftIdent, ok := n.Left.Expr.(*ast.Identifier); ok && isTDName(leftIdent.Name) {
		varName = leftIdent.Name
	}

	if varName == "" {
		return
	}

	lit, ok := n.Right.Expr.(*ast.StringLiteral)
	if !ok {
		return
	}
	if len(lit.Value) < 1 {
		return
	}

	if !isCorrectDomain(lit.Value, t.domain) {
		return
	}

	t.varMap[varName] = lit.Value
}

func isTDName(name string) bool {
	return strings.Contains(name, "td")
}

func isCorrectDomain(value string, domain string) bool {
	if strings.Contains(value, "https://") {
		if strings.Contains(value, domain) {
			return true
		}
		return false
	} else {
		return true
	}
}
