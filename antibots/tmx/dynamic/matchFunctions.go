package dynamic

import "github.com/t14raptor/go-fast/ast"

type FunctionsVisitor struct {
	ast.NoopVisitor
	varMap      map[string]string
	DynamicInfo DynamicInfo
}

func (v *FunctionsVisitor) VisitAssignExpression(n *ast.AssignExpression) {
	leftMemExpr, ok := n.Left.Expr.(*ast.MemberExpression)
	if !ok {
		return
	}
	memProp, ok := leftMemExpr.Property.Prop.(*ast.Identifier)
	if !ok || !isTDName(memProp.Name) {
		return
	}
	fn, ok := n.Right.Expr.(*ast.FunctionLiteral)
	if !ok {
		return
	}

	var cssVar string
	var sawCSS bool
	walkCalls(fn.Body.List, func(call *ast.CallExpression) {
		if len(call.ArgumentList) < 2 {
			return
		}

		// CheckUrl
		if bin, ok := call.ArgumentList[1].Expr.(*ast.BinaryExpression); ok {
			if lit, ok := bin.Right.Expr.(*ast.StringLiteral); ok && lit.Value == "&fcjs=1" {
				if member, ok := bin.Left.Expr.(*ast.MemberExpression); ok {
					if id, ok := member.Property.Prop.(*ast.Identifier); ok {
						v.assignFromMap(&v.DynamicInfo.CheckUrl, id.Name)
					}
				}
			}
		}

		// cssURl
		if len(call.ArgumentList) == 2 {
			if binExpr, ok := call.ArgumentList[1].Expr.(*ast.BinaryExpression); ok {
				if inner, ok := binExpr.Left.Expr.(*ast.BinaryExpression); ok {
					if lit, ok := inner.Left.Expr.(*ast.StringLiteral); ok && lit.Value == "url(" {
						if mem, ok := inner.Right.Expr.(*ast.MemberExpression); ok {
							if id, ok := mem.Property.Prop.(*ast.Identifier); ok {
								sawCSS = true
								cssVar = id.Name
								v.assignFromMap(&v.DynamicInfo.CssURl, id.Name)
							}
						}
					}
				}
			}
		}

		// imgSrcUrl
		if sawCSS {
			if mem, ok := call.ArgumentList[1].Expr.(*ast.MemberExpression); ok {
				if id, ok := mem.Property.Prop.(*ast.Identifier); ok && id.Name != cssVar {
					v.assignFromMap(&v.DynamicInfo.ImgSrcUrl, id.Name)
				}
			}
		}
	})
}

func (v *FunctionsVisitor) VisitFunctionDeclaration(n *ast.FunctionDeclaration) {
	body := n.Function.Body.List

	walkIfs(body, func(ifStmt *ast.IfStatement) {
		// cspUrl
		if bin, ok := ifStmt.Test.Expr.(*ast.BinaryExpression); ok {
			if lit, ok := bin.Right.Expr.(*ast.StringLiteral); ok && lit.Value == "Safari" {
				if block, ok := ifStmt.Consequent.Stmt.(*ast.BlockStatement); ok {
					for _, stmt := range block.List {
						decl, ok := stmt.Stmt.(*ast.VariableDeclaration)
						if !ok || len(decl.List) == 0 || decl.List[0].Initializer == nil {
							continue
						}
						if id, ok := decl.List[0].Initializer.Expr.(*ast.Identifier); ok {
							v.assignFromMap(&v.DynamicInfo.CspUrl, id.Name)
							break
						}
					}
				}
			}
		}

		// GHLUrl
		if hasProp(ifStmt.Test, "csp_nonce") {
			for _, stmt := range body {
				decl, ok := stmt.Stmt.(*ast.VariableDeclaration)
				if !ok || len(decl.List) == 0 || decl.List[0].Initializer == nil {
					continue
				}
				if id, ok := decl.List[0].Initializer.Expr.(*ast.Identifier); ok {
					v.assignFromMap(&v.DynamicInfo.GHLUrl, id.Name)
					break
				}
			}
		}
	})

	walkTries(body, func(try *ast.TryStatement) {
		// LOCSTOUrl
		hasGetItem := false
		walkCalls(try.Body.List, func(call *ast.CallExpression) {
			if hasGetItem || call.Callee == nil {
				return
			}
			if mem, ok := call.Callee.Expr.(*ast.MemberExpression); ok {
				if id, ok := mem.Property.Prop.(*ast.Identifier); ok && id.Name == "getItem" {
					hasGetItem = true
				}
			}
		})
		if hasGetItem {
			for _, stmt := range try.Body.List {
				decl, ok := stmt.Stmt.(*ast.VariableDeclaration)
				if !ok || len(decl.List) == 0 || decl.List[0].Initializer == nil {
					continue
				}
				if id, ok := decl.List[0].Initializer.Expr.(*ast.Identifier); ok {
					v.assignFromMap(&v.DynamicInfo.LocalStorageUrl, id.Name)
					break
				}
			}
		}

		// LSABValue + LSBUrl (localStorage try blocks)
		hasLS := false
		walkIfs(try.Body.List, func(ifStmt *ast.IfStatement) {
			if !hasLS && hasProp(ifStmt.Test, "localStorage") {
				hasLS = true
			}
		})
		if !hasLS {
			return
		}

		walkAssigns(try.Body.List, func(assign *ast.AssignExpression) {
			mem, ok := assign.Right.Expr.(*ast.MemberExpression)
			if !ok || mem.Object == nil {
				return
			}
			call, ok := mem.Object.Expr.(*ast.CallExpression)
			if !ok || call.Callee == nil {
				return
			}
			callee, ok := call.Callee.Expr.(*ast.MemberExpression)
			if !ok || callee.Object == nil {
				return
			}
			if id, ok := callee.Object.Expr.(*ast.Identifier); ok {
				v.assignFromMap(&v.DynamicInfo.LSABValue, id.Name)
			}
		})

		walkIfs(try.Body.List, func(ifStmt *ast.IfStatement) {
			block, ok := ifStmt.Consequent.Stmt.(*ast.BlockStatement)
			if !ok {
				return
			}
			for _, stmt := range block.List {
				decl, ok := stmt.Stmt.(*ast.VariableDeclaration)
				if !ok || len(decl.List) == 0 || decl.List[0].Initializer == nil {
					continue
				}
				bin, ok := decl.List[0].Initializer.Expr.(*ast.BinaryExpression)
				if !ok || bin.Left == nil {
					continue
				}
				if id, ok := bin.Left.Expr.(*ast.Identifier); ok {
					v.assignFromMap(&v.DynamicInfo.LSBUrl, id.Name)
				}
			}
		})
	})

	// Nonce (td_Dk) - return object has "nonce" key, var decl is td_k6 ? td_1G : td_5P
	if hasReturnObjectKey(body, "nonce") {
		for _, stmt := range body {
			decl, ok := stmt.Stmt.(*ast.VariableDeclaration)
			if !ok || len(decl.List) == 0 || decl.List[0].Initializer == nil {
				continue
			}
			cond, ok := decl.List[0].Initializer.Expr.(*ast.ConditionalExpression)
			if !ok {
				continue
			}
			if id, ok := cond.Alternate.Expr.(*ast.Identifier); ok {
				v.assignFromMap(&v.DynamicInfo.Nonce, id.Name)
				break
			}
		}
	}

	// SigUrl (td_XP) - var builds "sid_rnd=", then td_5Q + ... td_4A(td_Wo, ...)
	if hasSidRndVarDecl(body) {
		for _, stmt := range body {
			decl, ok := stmt.Stmt.(*ast.VariableDeclaration)
			if !ok || len(decl.List) == 0 || decl.List[0].Initializer == nil {
				continue
			}
			if !exprHasJfEncrypt(decl.List[0].Initializer) {
				continue
			}
			if name := leftIdent(decl.List[0].Initializer.Expr); name != "" {
				v.assignFromMap(&v.DynamicInfo.SigUrl, name)
				break
			}
		}
	}

	// CheckUrl2 (formerly jajbUrl)
	for i := 0; i+1 < len(body); i++ {
		decl, ok := body[i].Stmt.(*ast.VariableDeclaration)
		if !ok || len(decl.List) == 0 || decl.List[0].Initializer == nil {
			continue
		}
		cond, ok := decl.List[0].Initializer.Expr.(*ast.ConditionalExpression)
		if !ok || !isNavUserAgent(cond.Test) {
			continue
		}
		next, ok := body[i+1].Stmt.(*ast.VariableDeclaration)
		if !ok || len(next.List) == 0 || next.List[0].Initializer == nil {
			continue
		}
		if id := leftIdent(next.List[0].Initializer.Expr); id != "" {
			v.assignFromMap(&v.DynamicInfo.CheckUrl2, id)
			break
		}
	}
}

func (v *FunctionsVisitor) assignFromMap(dst *string, varName string) {
	if dst == nil || *dst != "" {
		return
	}

	if val := v.varMap[varName]; val != "" {
		*dst = val
	}
}

func hasSidRndVarDecl(stmts ast.Statements) bool {
	for _, stmt := range stmts {
		decl, ok := stmt.Stmt.(*ast.VariableDeclaration)
		if !ok || len(decl.List) == 0 || decl.List[0].Initializer == nil {
			continue
		}
		if exprHasStringLiteral(decl.List[0].Initializer, "sid_rnd=") {
			return true
		}
	}
	return false
}

func exprHasStringLiteral(expr *ast.Expression, want string) bool {
	if expr == nil || expr.Expr == nil {
		return false
	}
	switch e := expr.Expr.(type) {
	case *ast.StringLiteral:
		return e.Value == want
	case *ast.BinaryExpression:
		return exprHasStringLiteral(e.Left, want) || exprHasStringLiteral(e.Right, want)
	case *ast.MemberExpression:
		return exprHasStringLiteral(e.Object, want)
	case *ast.ConditionalExpression:
		return exprHasStringLiteral(e.Test, want) || exprHasStringLiteral(e.Consequent, want) || exprHasStringLiteral(e.Alternate, want)
	case *ast.CallExpression:
		if exprHasStringLiteral(e.Callee, want) {
			return true
		}
		for i := range e.ArgumentList {
			if exprHasStringLiteral(&e.ArgumentList[i], want) {
				return true
			}
		}
	}
	return false
}

func exprHasJfEncrypt(expr *ast.Expression) bool {
	if exprHasStringLiteral(expr, "&jf=") {
		return true
	}
	return exprHasTDMemberEncryptCall(expr)
}

func exprHasTDMemberEncryptCall(expr *ast.Expression) bool {
	if expr == nil || expr.Expr == nil {
		return false
	}
	switch e := expr.Expr.(type) {
	case *ast.CallExpression:
		if mem, ok := e.Callee.Expr.(*ast.MemberExpression); ok {
			if id, ok := mem.Property.Prop.(*ast.Identifier); ok && isTDName(id.Name) && len(e.ArgumentList) >= 2 {
				return true
			}
		}
		if exprHasTDMemberEncryptCall(e.Callee) {
			return true
		}
		for i := range e.ArgumentList {
			if exprHasTDMemberEncryptCall(&e.ArgumentList[i]) {
				return true
			}
		}
	case *ast.BinaryExpression:
		return exprHasTDMemberEncryptCall(e.Left) || exprHasTDMemberEncryptCall(e.Right)
	case *ast.ConditionalExpression:
		return exprHasTDMemberEncryptCall(e.Test) || exprHasTDMemberEncryptCall(e.Consequent) || exprHasTDMemberEncryptCall(e.Alternate)
	}
	return false
}

func hasReturnObjectKey(stmts ast.Statements, key string) bool {
	for _, stmt := range stmts {
		ret, ok := stmt.Stmt.(*ast.ReturnStatement)
		if !ok || ret.Argument == nil {
			continue
		}
		obj, ok := ret.Argument.Expr.(*ast.ObjectLiteral)
		if !ok {
			continue
		}
		for _, prop := range obj.Value {
			keyed, ok := prop.Prop.(*ast.PropertyKeyed)
			if !ok || keyed.Key == nil {
				continue
			}
			lit, ok := keyed.Key.Expr.(*ast.StringLiteral)
			if ok && lit.Value == key {
				return true
			}
		}
	}
	return false
}

func isNavUserAgent(expr *ast.Expression) bool {
	mem, ok := expr.Expr.(*ast.MemberExpression)
	if !ok {
		return false
	}
	obj, ok := mem.Object.Expr.(*ast.Identifier)
	if !ok || obj.Name != "navigator" {
		return false
	}
	prop, ok := mem.Property.Prop.(*ast.Identifier)
	return ok && prop.Name == "userAgent"
}

func leftIdent(expr ast.Expr) string {
	if expr == nil {
		return ""
	}
	switch e := expr.(type) {
	case *ast.Identifier:
		return e.Name
	case *ast.BinaryExpression:
		return leftIdent(e.Left.Expr)
	default:
		return ""
	}
}

func hasProp(expr *ast.Expression, prop string) bool {
	if expr == nil || expr.Expr == nil {
		return false
	}
	switch e := expr.Expr.(type) {
	case *ast.MemberExpression:
		if id, ok := e.Property.Prop.(*ast.Identifier); ok && id.Name == prop {
			return true
		}
		return hasProp(e.Object, prop)
	case *ast.BinaryExpression:
		return hasProp(e.Left, prop) || hasProp(e.Right, prop)
	case *ast.LogicalExpression:
		return hasProp(e.Left, prop) || hasProp(e.Right, prop)
	case *ast.UnaryExpression:
		return hasProp(e.Operand, prop)
	case *ast.CallExpression:
		if hasProp(e.Callee, prop) {
			return true
		}
		for i := range e.ArgumentList {
			if hasProp(&e.ArgumentList[i], prop) {
				return true
			}
		}
	}
	return false
}

func walkStmts(stmts ast.Statements, fn func(ast.Stmt)) {
	for _, stmt := range stmts {
		if stmt.Stmt == nil {
			continue
		}
		walkStmt(stmt.Stmt, fn)
	}
}

func walkStmt(stmt ast.Stmt, fn func(ast.Stmt)) {
	if stmt == nil {
		return
	}
	fn(stmt)
	switch s := stmt.(type) {
	case *ast.BlockStatement:
		walkStmts(s.List, fn)
	case *ast.IfStatement:
		if s.Consequent != nil {
			walkStmt(s.Consequent.Stmt, fn)
		}
		if s.Alternate != nil {
			walkStmt(s.Alternate.Stmt, fn)
		}
	case *ast.TryStatement:
		if s.Body != nil {
			walkStmts(s.Body.List, fn)
		}
		if s.Catch != nil && s.Catch.Body != nil {
			walkStmts(s.Catch.Body.List, fn)
		}
		if s.Finally != nil {
			walkStmts(s.Finally.List, fn)
		}
	}
}

func walkExprs(stmts ast.Statements, fn func(ast.Expr)) {
	walkStmts(stmts, func(stmt ast.Stmt) {
		switch s := stmt.(type) {
		case *ast.ExpressionStatement:
			walkExpr(s.Expression, fn)
		case *ast.VariableDeclaration:
			for _, d := range s.List {
				walkExpr(d.Initializer, fn)
			}
		case *ast.IfStatement:
			walkExpr(s.Test, fn)
		}
	})
}

func walkExpr(expr *ast.Expression, fn func(ast.Expr)) {
	if expr == nil || expr.Expr == nil {
		return
	}
	fn(expr.Expr)
	switch e := expr.Expr.(type) {
	case *ast.CallExpression:
		walkExpr(e.Callee, fn)
		for i := range e.ArgumentList {
			walkExpr(&e.ArgumentList[i], fn)
		}
	case *ast.BinaryExpression:
		walkExpr(e.Left, fn)
		walkExpr(e.Right, fn)
	case *ast.LogicalExpression:
		walkExpr(e.Left, fn)
		walkExpr(e.Right, fn)
	case *ast.UnaryExpression:
		walkExpr(e.Operand, fn)
	case *ast.AssignExpression:
		walkExpr(e.Left, fn)
		walkExpr(e.Right, fn)
	case *ast.MemberExpression:
		walkExpr(e.Object, fn)
	case *ast.ConditionalExpression:
		walkExpr(e.Test, fn)
		walkExpr(e.Consequent, fn)
		walkExpr(e.Alternate, fn)
	}
}

func walkCalls(stmts ast.Statements, fn func(*ast.CallExpression)) {
	walkExprs(stmts, func(e ast.Expr) {
		if call, ok := e.(*ast.CallExpression); ok {
			fn(call)
		}
	})
}

func walkAssigns(stmts ast.Statements, fn func(*ast.AssignExpression)) {
	walkExprs(stmts, func(e ast.Expr) {
		if assign, ok := e.(*ast.AssignExpression); ok {
			fn(assign)
		}
	})
}

func walkIfs(stmts ast.Statements, fn func(*ast.IfStatement)) {
	walkStmts(stmts, func(stmt ast.Stmt) {
		if ifStmt, ok := stmt.(*ast.IfStatement); ok {
			fn(ifStmt)
		}
	})
}

func walkTries(stmts ast.Statements, fn func(*ast.TryStatement)) {
	walkStmts(stmts, func(stmt ast.Stmt) {
		if try, ok := stmt.(*ast.TryStatement); ok {
			fn(try)
		}
	})
}
