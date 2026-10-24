// Benchmark program (~500 lines, std only, deterministic output).
// Exercises generics, traits, enums, pattern matching, closures, iterators and collections,
// which is roughly what a small user project looks like. Ends with "medium ok".

use std::collections::{BTreeMap, HashMap, HashSet, VecDeque};
use std::fmt;

// ---------- Lexer ----------

#[derive(Debug, Clone, PartialEq)]
enum Token {
    Num(f64),
    Ident(String),
    Op(char),
    LParen,
    RParen,
    Let,
    Assign,
    Semi,
    Comma,
}

struct Lexer<'a> {
    chars: std::iter::Peekable<std::str::Chars<'a>>,
}

impl<'a> Lexer<'a> {
    fn new(src: &'a str) -> Self {
        Lexer { chars: src.chars().peekable() }
    }

    fn tokens(mut self) -> Result<Vec<Token>, String> {
        let mut out = Vec::new();
        while let Some(&c) = self.chars.peek() {
            match c {
                ' ' | '\n' | '\t' => {
                    self.chars.next();
                }
                '0'..='9' | '.' => out.push(Token::Num(self.number()?)),
                'a'..='z' | 'A'..='Z' | '_' => {
                    let id = self.ident();
                    out.push(if id == "let" { Token::Let } else { Token::Ident(id) });
                }
                '+' | '-' | '*' | '/' | '^' | '%' => {
                    out.push(Token::Op(c));
                    self.chars.next();
                }
                '(' => {
                    out.push(Token::LParen);
                    self.chars.next();
                }
                ')' => {
                    out.push(Token::RParen);
                    self.chars.next();
                }
                '=' => {
                    out.push(Token::Assign);
                    self.chars.next();
                }
                ';' => {
                    out.push(Token::Semi);
                    self.chars.next();
                }
                ',' => {
                    out.push(Token::Comma);
                    self.chars.next();
                }
                other => return Err(format!("unexpected character {other:?}")),
            }
        }
        Ok(out)
    }

    fn number(&mut self) -> Result<f64, String> {
        let mut s = String::new();
        while let Some(&c) = self.chars.peek() {
            if c.is_ascii_digit() || c == '.' {
                s.push(c);
                self.chars.next();
            } else {
                break;
            }
        }
        s.parse().map_err(|e| format!("bad number {s}: {e}"))
    }

    fn ident(&mut self) -> String {
        let mut s = String::new();
        while let Some(&c) = self.chars.peek() {
            if c.is_alphanumeric() || c == '_' {
                s.push(c);
                self.chars.next();
            } else {
                break;
            }
        }
        s
    }
}

// ---------- Parser (Pratt) ----------

#[derive(Debug, Clone)]
enum Expr {
    Num(f64),
    Var(String),
    Neg(Box<Expr>),
    Bin(char, Box<Expr>, Box<Expr>),
    Call(String, Vec<Expr>),
}

#[derive(Debug)]
enum Stmt {
    Let(String, Expr),
    Print(Expr),
}

struct Parser {
    toks: Vec<Token>,
    pos: usize,
}

impl Parser {
    fn peek(&self) -> Option<&Token> {
        self.toks.get(self.pos)
    }

    fn next(&mut self) -> Option<Token> {
        let t = self.toks.get(self.pos).cloned();
        self.pos += 1;
        t
    }

    fn expect(&mut self, t: Token) -> Result<(), String> {
        match self.next() {
            Some(ref got) if *got == t => Ok(()),
            got => Err(format!("expected {t:?}, got {got:?}")),
        }
    }

    fn program(&mut self) -> Result<Vec<Stmt>, String> {
        let mut stmts = Vec::new();
        while self.peek().is_some() {
            let s = if self.peek() == Some(&Token::Let) {
                self.next();
                let name = match self.next() {
                    Some(Token::Ident(n)) => n,
                    t => return Err(format!("expected name, got {t:?}")),
                };
                self.expect(Token::Assign)?;
                Stmt::Let(name, self.expr(0)?)
            } else {
                Stmt::Print(self.expr(0)?)
            };
            stmts.push(s);
            self.expect(Token::Semi)?;
        }
        Ok(stmts)
    }

    fn binding_power(op: char) -> (u8, u8) {
        match op {
            '+' | '-' => (1, 2),
            '*' | '/' | '%' => (3, 4),
            '^' => (6, 5),
            _ => (0, 0),
        }
    }

    fn expr(&mut self, min_bp: u8) -> Result<Expr, String> {
        let mut lhs = match self.next() {
            Some(Token::Num(n)) => Expr::Num(n),
            Some(Token::Ident(name)) => {
                if self.peek() == Some(&Token::LParen) {
                    self.next();
                    let mut args = Vec::new();
                    if self.peek() != Some(&Token::RParen) {
                        loop {
                            args.push(self.expr(0)?);
                            if self.peek() == Some(&Token::Comma) {
                                self.next();
                            } else {
                                break;
                            }
                        }
                    }
                    self.expect(Token::RParen)?;
                    Expr::Call(name, args)
                } else {
                    Expr::Var(name)
                }
            }
            Some(Token::Op('-')) => Expr::Neg(Box::new(self.expr(5)?)),
            Some(Token::LParen) => {
                let e = self.expr(0)?;
                self.expect(Token::RParen)?;
                e
            }
            t => return Err(format!("unexpected token {t:?}")),
        };
        while let Some(Token::Op(op)) = self.peek().cloned() {
            let (l, r) = Self::binding_power(op);
            if l < min_bp {
                break;
            }
            self.next();
            let rhs = self.expr(r)?;
            lhs = Expr::Bin(op, Box::new(lhs), Box::new(rhs));
        }
        Ok(lhs)
    }
}

// ---------- Evaluator ----------

struct Interp {
    vars: HashMap<String, f64>,
    funcs: HashMap<&'static str, Box<dyn Fn(&[f64]) -> f64>>,
    output: Vec<String>,
}

impl Interp {
    fn new() -> Self {
        let mut funcs: HashMap<&'static str, Box<dyn Fn(&[f64]) -> f64>> = HashMap::new();
        funcs.insert("max", Box::new(|a| a.iter().cloned().fold(f64::MIN, f64::max)));
        funcs.insert("min", Box::new(|a| a.iter().cloned().fold(f64::MAX, f64::min)));
        funcs.insert("sum", Box::new(|a| a.iter().sum()));
        funcs.insert("sqrt", Box::new(|a| a[0].sqrt()));
        Interp { vars: HashMap::new(), funcs, output: Vec::new() }
    }

    fn eval(&self, e: &Expr) -> Result<f64, String> {
        Ok(match e {
            Expr::Num(n) => *n,
            Expr::Var(v) => *self.vars.get(v).ok_or_else(|| format!("unknown variable {v}"))?,
            Expr::Neg(x) => -self.eval(x)?,
            Expr::Bin(op, a, b) => {
                let (a, b) = (self.eval(a)?, self.eval(b)?);
                match op {
                    '+' => a + b,
                    '-' => a - b,
                    '*' => a * b,
                    '/' => a / b,
                    '%' => a % b,
                    '^' => a.powf(b),
                    _ => unreachable!(),
                }
            }
            Expr::Call(f, args) => {
                let vals = args.iter().map(|a| self.eval(a)).collect::<Result<Vec<_>, _>>()?;
                let func = self.funcs.get(f.as_str()).ok_or_else(|| format!("unknown function {f}"))?;
                func(&vals)
            }
        })
    }

    fn run(&mut self, src: &str) -> Result<(), String> {
        let toks = Lexer::new(src).tokens()?;
        let prog = Parser { toks, pos: 0 }.program()?;
        for stmt in prog {
            match stmt {
                Stmt::Let(name, e) => {
                    let v = self.eval(&e)?;
                    self.vars.insert(name, v);
                }
                Stmt::Print(e) => {
                    let v = self.eval(&e)?;
                    self.output.push(format!("{v}"));
                }
            }
        }
        Ok(())
    }
}

// ---------- Traits and generics ----------

trait Shape {
    fn area(&self) -> f64;
    fn name(&self) -> String;
    fn describe(&self) -> String {
        format!("{} with area {:.2}", self.name(), self.area())
    }
}

struct Circle(f64);
struct Rect {
    w: f64,
    h: f64,
}
struct Triangle {
    a: f64,
    b: f64,
    c: f64,
}

impl Shape for Circle {
    fn area(&self) -> f64 {
        std::f64::consts::PI * self.0 * self.0
    }
    fn name(&self) -> String {
        "circle".into()
    }
}

impl Shape for Rect {
    fn area(&self) -> f64 {
        self.w * self.h
    }
    fn name(&self) -> String {
        if self.w == self.h { "square".into() } else { "rectangle".into() }
    }
}

impl Shape for Triangle {
    fn area(&self) -> f64 {
        let s = (self.a + self.b + self.c) / 2.0;
        (s * (s - self.a) * (s - self.b) * (s - self.c)).sqrt()
    }
    fn name(&self) -> String {
        "triangle".into()
    }
}

#[derive(Debug, Clone, Copy, PartialEq)]
struct Matrix<const N: usize> {
    m: [[i64; N]; N],
}

impl<const N: usize> Matrix<N> {
    fn identity() -> Self {
        let mut m = [[0; N]; N];
        for (i, row) in m.iter_mut().enumerate() {
            row[i] = 1;
        }
        Matrix { m }
    }

    fn mul(&self, o: &Self) -> Self {
        let mut m = [[0; N]; N];
        for i in 0..N {
            for j in 0..N {
                m[i][j] = (0..N).map(|k| self.m[i][k] * o.m[k][j]).sum();
            }
        }
        Matrix { m }
    }

    fn pow(&self, mut e: u32) -> Self {
        let (mut base, mut acc) = (*self, Self::identity());
        while e > 0 {
            if e & 1 == 1 {
                acc = acc.mul(&base);
            }
            base = base.mul(&base);
            e >>= 1;
        }
        acc
    }
}

impl<const N: usize> fmt::Display for Matrix<N> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        for row in &self.m {
            let cells: Vec<String> = row.iter().map(|c| c.to_string()).collect();
            writeln!(f, "[{}]", cells.join(", "))?;
        }
        Ok(())
    }
}

struct Stack<T> {
    items: Vec<T>,
}

impl<T: Clone + fmt::Debug> Stack<T> {
    fn new() -> Self {
        Stack { items: Vec::new() }
    }
    fn push(&mut self, t: T) {
        self.items.push(t);
    }
    fn pop(&mut self) -> Option<T> {
        self.items.pop()
    }
    fn peek(&self) -> Option<&T> {
        self.items.last()
    }
    fn len(&self) -> usize {
        self.items.len()
    }
}

// ---------- Algorithms ----------

fn sieve(n: usize) -> Vec<usize> {
    let mut is = vec![true; n + 1];
    is[0] = false;
    if n >= 1 {
        is[1] = false;
    }
    let mut i = 2;
    while i * i <= n {
        if is[i] {
            let mut j = i * i;
            while j <= n {
                is[j] = false;
                j += i;
            }
        }
        i += 1;
    }
    is.iter().enumerate().filter(|(_, &p)| p).map(|(i, _)| i).collect()
}

fn bfs(grid: &[&str], start: (usize, usize), goal: (usize, usize)) -> Option<usize> {
    let h = grid.len();
    let w = grid[0].len();
    let cells: Vec<Vec<u8>> = grid.iter().map(|r| r.bytes().collect()).collect();
    let mut seen = HashSet::new();
    let mut q = VecDeque::new();
    q.push_back((start, 0));
    seen.insert(start);
    while let Some(((r, c), d)) = q.pop_front() {
        if (r, c) == goal {
            return Some(d);
        }
        let dirs: [(isize, isize); 4] = [(0, 1), (1, 0), (0, -1), (-1, 0)];
        for (dr, dc) in dirs {
            let (nr, nc) = (r as isize + dr, c as isize + dc);
            if nr < 0 || nc < 0 || nr >= h as isize || nc >= w as isize {
                continue;
            }
            let n = (nr as usize, nc as usize);
            if cells[n.0][n.1] != b'#' && seen.insert(n) {
                q.push_back((n, d + 1));
            }
        }
    }
    None
}

fn word_freq(text: &str) -> BTreeMap<String, usize> {
    let mut m = BTreeMap::new();
    for w in text
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| !w.is_empty())
        .map(|w| w.to_lowercase())
    {
        *m.entry(w).or_insert(0) += 1;
    }
    m
}

fn fib_memo(n: u64, memo: &mut HashMap<u64, u64>) -> u64 {
    if n < 2 {
        return n;
    }
    if let Some(&v) = memo.get(&n) {
        return v;
    }
    let v = fib_memo(n - 1, memo) + fib_memo(n - 2, memo);
    memo.insert(n, v);
    v
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct Employee {
    dept: String,
    name: String,
    salary: u32,
}

fn payroll(staff: &[Employee]) -> Vec<(String, u32, String)> {
    let mut by_dept: BTreeMap<&str, Vec<&Employee>> = BTreeMap::new();
    for e in staff {
        by_dept.entry(e.dept.as_str()).or_default().push(e);
    }
    by_dept
        .into_iter()
        .map(|(d, es)| {
            let total = es.iter().map(|e| e.salary).sum();
            let top = es.iter().max_by_key(|e| e.salary).map(|e| e.name.clone()).unwrap_or_default();
            (d.to_string(), total, top)
        })
        .collect()
}

// ---------- main ----------

fn main() {
    let mut interp = Interp::new();
    let src = "let x = 3; let y = 4; sqrt(x^2 + y^2); max(1, x * y, 7) - min(2, -y); sum(1, 2, 3, 4) % 3;";
    match interp.run(src) {
        Ok(()) => println!("interp: {}", interp.output.join(" | ")),
        Err(e) => println!("interp error: {e}"),
    }
    if let Err(e) = Interp::new().run("let z = 1 +;") {
        println!("expected parse error: {e}");
    }

    let shapes: Vec<Box<dyn Shape>> = vec![
        Box::new(Circle(1.5)),
        Box::new(Rect { w: 2.0, h: 3.0 }),
        Box::new(Rect { w: 2.0, h: 2.0 }),
        Box::new(Triangle { a: 3.0, b: 4.0, c: 5.0 }),
    ];
    let mut sorted: Vec<&Box<dyn Shape>> = shapes.iter().collect();
    sorted.sort_by(|a, b| a.area().partial_cmp(&b.area()).unwrap());
    for s in sorted {
        println!("shape: {}", s.describe());
    }
    let total: f64 = shapes.iter().map(|s| s.area()).sum();
    println!("total area {total:.3}");

    let fib = Matrix::<2> { m: [[1, 1], [1, 0]] };
    print!("fib matrix^10:\n{}", fib.pow(10));
    let mut memo = HashMap::new();
    println!("fib(80) = {}", fib_memo(80, &mut memo));

    let mut st: Stack<(u8, &str)> = Stack::new();
    for (i, w) in ["alpha", "beta", "gamma", "delta"].iter().enumerate() {
        st.push((i as u8, w));
    }
    println!("stack peek {:?}, len {}", st.peek(), st.len());
    while let Some((i, w)) = st.pop() {
        print!("{i}:{w} ");
    }
    println!();

    let primes = sieve(100);
    println!("{} primes below 100, last {:?}", primes.len(), primes.last());
    let twin: Vec<(usize, usize)> = primes.windows(2).filter(|w| w[1] - w[0] == 2).map(|w| (w[0], w[1])).collect();
    println!("twin primes: {twin:?}");

    let grid = ["..#.......", "..#.####..", "....#.....", "###.#.###.", "......#..."];
    println!("bfs shortest path: {:?}", bfs(&grid, (0, 0), (4, 9)));

    let text = "the quick brown fox jumps over the lazy dog. The dog sleeps; the fox runs.";
    let freq = word_freq(text);
    let mut top: Vec<(&String, &usize)> = freq.iter().collect();
    top.sort_by(|a, b| b.1.cmp(a.1).then(a.0.cmp(b.0)));
    println!("top words: {:?}", &top[..3]);

    let staff = vec![
        Employee { dept: "eng".into(), name: "ada".into(), salary: 120 },
        Employee { dept: "eng".into(), name: "linus".into(), salary: 110 },
        Employee { dept: "ops".into(), name: "grace".into(), salary: 95 },
        Employee { dept: "ops".into(), name: "ken".into(), salary: 99 },
        Employee { dept: "research".into(), name: "barbara".into(), salary: 130 },
    ];
    for (d, total, top) in payroll(&staff) {
        println!("dept {d}: total {total}, top earner {top}");
    }
    let mut by_salary = staff.clone();
    by_salary.sort_by(|a, b| b.salary.cmp(&a.salary).then_with(|| a.name.cmp(&b.name)));
    let names: Vec<&str> = by_salary.iter().map(|e| e.name.as_str()).collect();
    println!("by salary: {}", names.join(" > "));

    let checksum = (1..=1000u64).filter(|n| n % 3 == 0 || n % 5 == 0).fold(0u64, |a, n| a.wrapping_mul(31).wrapping_add(n));
    println!("checksum {checksum}");
    println!("medium ok");
}
