package dynamic

import (
	"encoding/hex"
	"fmt"
	"math"
	"strconv"

	"github.com/t14raptor/go-fast/ast"
)

type DeobfStringsVisitor struct {
	ast.NoopVisitor
	decodedTables map[string]string
}

func (v *DeobfStringsVisitor) VisitExpression(node *ast.Expression) {
	if node == nil || node.Expr == nil {
		return
	}
	node.VisitChildrenWith(v)

	if v.decodedTables == nil {
		v.decodedTables = make(map[string]string)
	}

	if assignExpr, ok := node.Expr.(*ast.AssignExpression); ok {
		v.captureDecodedTable(assignExpr)
	}

	if callExpr, ok := node.Expr.(*ast.CallExpression); ok {
		if decoded, ok := v.decodeTdFCall(callExpr); ok {
			node.Expr = &ast.StringLiteral{Value: decoded}
			return
		}
	}

	if literal, ok := evalNumberToString(node); ok {
		node.Expr = literal
		return
	}

	if condExpr, ok := node.Expr.(*ast.ConditionalExpression); ok {
		if literal, ok := condExpr.Consequent.Expr.(*ast.StringLiteral); ok {
			if _, isNull := condExpr.Alternate.Expr.(*ast.NullLiteral); isNull {
				node.Expr = &ast.StringLiteral{Value: literal.Value}
			}
		}
	}
}

func (v *DeobfStringsVisitor) VisitVariableDeclarator(node *ast.VariableDeclarator) {
	if node == nil {
		return
	}
	node.VisitChildrenWith(v)

	if v.decodedTables == nil {
		v.decodedTables = make(map[string]string)
	}

	v.captureDecodedTableDeclarator(node)
}

func (v *DeobfStringsVisitor) captureDecodedTable(assignExpr *ast.AssignExpression) {
	if assignExpr == nil || assignExpr.Left == nil || assignExpr.Right == nil {
		return
	}

	key, ok := expressionKey(assignExpr.Left)
	if !ok {
		return
	}

	newExpr, ok := assignExpr.Right.Expr.(*ast.NewExpression)
	if !ok || len(newExpr.ArgumentList) != 1 {
		return
	}

	literal, ok := newExpr.ArgumentList[0].Expr.(*ast.StringLiteral)
	if !ok {
		return
	}

	decodedValue, err := decodeString(literal.Value)
	if err != nil {
		return
	}

	v.decodedTables[key] = decodedValue
}

func (v *DeobfStringsVisitor) captureDecodedTableDeclarator(decl *ast.VariableDeclarator) {
	if decl == nil || decl.Target == nil || decl.Initializer == nil || decl.Initializer.Expr == nil {
		return
	}

	key, ok := bindingTargetKey(decl.Target)
	if !ok {
		return
	}

	newExpr, ok := decl.Initializer.Expr.(*ast.NewExpression)
	if !ok || len(newExpr.ArgumentList) != 1 {
		return
	}

	literal, ok := newExpr.ArgumentList[0].Expr.(*ast.StringLiteral)
	if !ok {
		return
	}

	decodedValue, err := decodeString(literal.Value)
	if err != nil {
		fmt.Println(err)
		return
	}

	v.decodedTables[key] = decodedValue
}

func (v *DeobfStringsVisitor) decodeTdFCall(callExpr *ast.CallExpression) (string, bool) {
	if callExpr == nil || callExpr.Callee == nil || len(callExpr.ArgumentList) != 2 {
		return "", false
	}

	memberExpr, ok := callExpr.Callee.Expr.(*ast.MemberExpression)
	if !ok {
		return "", false
	}

	propIdent, ok := memberExpr.Property.Prop.(*ast.Identifier)
	if !ok || propIdent.Name != "td_f" {
		return "", false
	}

	targetKey, ok := expressionKey(memberExpr.Object)
	if !ok {
		return "", false
	}

	decodedSource, ok := v.decodedTables[targetKey]
	if !ok {
		return "", false
	}

	start, ok := numberLiteralToInt(callExpr.ArgumentList[0].Expr)
	if !ok {
		return "", false
	}

	length, ok := numberLiteralToInt(callExpr.ArgumentList[1].Expr)
	if !ok {
		return "", false
	}

	if start < 0 || length < 0 || start > len(decodedSource) {
		return "", false
	}

	end := start + length
	if end > len(decodedSource) {
		end = len(decodedSource)
	}
	return decodedSource[start:end], true
}

func expressionKey(expr *ast.Expression) (string, bool) {
	if expr == nil || expr.Expr == nil {
		return "", false
	}

	return expressionKeyFromExpr(expr.Expr)
}

func expressionKeyFromExpr(expr ast.Expr) (string, bool) {
	switch e := expr.(type) {
	case *ast.Identifier:
		return e.Name, true
	case *ast.MemberExpression:
		left, ok := expressionKey(e.Object)
		if !ok {
			return "", false
		}

		propIdent, ok := e.Property.Prop.(*ast.Identifier)
		if !ok {
			return "", false
		}

		return left + "." + propIdent.Name, true
	default:
		return "", false
	}
}

func bindingTargetKey(target *ast.BindingTarget) (string, bool) {
	if target == nil || target.Target == nil {
		return "", false
	}

	return expressionKeyFromExpr(target.Target)
}

func evalNumberToString(node *ast.Expression) (*ast.StringLiteral, bool) {
	if node == nil || node.Expr == nil {
		return nil, false
	}

	callExpr, ok := node.Expr.(*ast.CallExpression)
	if !ok || callExpr.Callee == nil || len(callExpr.ArgumentList) != 1 {
		return nil, false
	}

	memberExpr, ok := callExpr.Callee.Expr.(*ast.MemberExpression)
	if !ok || memberExpr.Object == nil || memberExpr.Property == nil {
		return nil, false
	}

	propIdent, ok := memberExpr.Property.Prop.(*ast.Identifier)
	if !ok || propIdent.Name != "toString" {
		return nil, false
	}

	numberCall, ok := memberExpr.Object.Expr.(*ast.CallExpression)
	if !ok || numberCall.Callee == nil || len(numberCall.ArgumentList) != 1 {
		return nil, false
	}

	numberIdent, ok := numberCall.Callee.Expr.(*ast.Identifier)
	if !ok || numberIdent.Name != "Number" {
		return nil, false
	}

	value, ok := numberLiteralToInt(numberCall.ArgumentList[0].Expr)
	if !ok {
		return nil, false
	}

	radix, ok := numberLiteralToInt(callExpr.ArgumentList[0].Expr)
	if !ok || radix < 2 || radix > 36 {
		return nil, false
	}

	return &ast.StringLiteral{Value: strconv.FormatInt(int64(value), radix)}, true
}

func numberLiteralToInt(expr ast.Expr) (int, bool) {
	num, ok := expr.(*ast.NumberLiteral)
	if !ok {
		return 0, false
	}

	if math.Trunc(num.Value) != num.Value {
		return 0, false
	}

	return int(num.Value), true
}

func decodeString(s string) (string, error) {
	if len(s) < 32 {
		return "", fmt.Errorf("input too short")
	}

	data, err := hex.DecodeString(s[32:])
	if err != nil {
		return "", err
	}
	keyBytes := []byte(s[:32])
	out := make([]byte, len(data))
	for i, b := range data {
		out[i] = keyBytes[i%len(keyBytes)] ^ b
	}
	return string(out), nil
}
