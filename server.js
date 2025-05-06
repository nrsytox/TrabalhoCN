require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const session = require("express-session");
const { CosmosClient } = require("@azure/cosmos");
const path = require("path");

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));

// Sessões
app.use(session({
  secret: "segredo-super-seguro",
  resave: false,
  saveUninitialized: true
}));

// Cosmos DB config
const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const databaseId = "gestao_despesas";
const containerId = "user";

const client = new CosmosClient({ endpoint, key });
const container = client.database(databaseId).container(containerId);

// Middleware de autenticação
function authMiddleware(req, res, next) {
  if (req.session.user)
    next();
  else
    res.redirect("/");

}

// ======================= ROTAS ========================== //

// Página inicial
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Página do dashboard
app.get("/dashboard", authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "dashboard.html"));
});

// Página do perfil
app.get("/perfil", authMiddleware, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "perfil.html"));
});

// API para obter dados do perfil
app.get("/api/perfil", authMiddleware, (req, res) => {
  res.json(req.session.user);
});

// Registar
app.post("/auth/register", async (req, res) => {
  const { nome, email, password, orcamento_mensal } = req.body;

  const { resources: existingUsers } = await container.items
    .query({
      query: "SELECT * FROM c WHERE c.email = @email",
      parameters: [{ name: "@email", value: email }]
    })
    .fetchAll();

  if (existingUsers.length > 0) {
    return res.status(400).json({ message: "Email já registado" });
  }

  const hashedPassword = await bcrypt.hash(password, 10);

  const newUser = {
    id: uuidv4(),
    nome,
    email,
    password: hashedPassword,
    orcamento_mensal: Number(orcamento_mensal),
    orcamento_restante: Number(orcamento_mensal),
    grupos: []
  };

  await container.items.create(newUser);
  req.session.user = {
    id: newUser.id,
    nome: newUser.nome,
    email: newUser.email,
    orcamento_mensal: newUser.orcamento_mensal,
    orcamento_restante: newUser.orcamento_restante
  };
  res.redirect("/dashboard");
});

// Login
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;

  const { resources } = await container.items
    .query({
      query: "SELECT * FROM c WHERE c.email = @email",
      parameters: [{ name: "@email", value: email }]
    })
    .fetchAll();

  if (resources.length === 0) {
    return res.status(401).json({ message: "Email não encontrado" });
  }

  const user = resources[0];
  const valid = await bcrypt.compare(password, user.password);

  if (!valid) {
    return res.status(401).json({ message: "Password incorreta" });
  }

  // Guardar dados do utilizador na sessão
  req.session.user = {
    id: user.id,
    nome: user.nome,
    email: user.email,
    orcamento_mensal: user.orcamento_mensal,
    orcamento_restante: user.orcamento_restante
  };

  res.redirect("/dashboard");
});

// Endpoint para categorias
app.get("/api/categorias", async (req, res) => {
  const categoriaContainer = client.database("gestao_despesas").container("categorias");
  const { resources } = await categoriaContainer.items.query("SELECT * FROM c").fetchAll();
  res.json(resources);
});

// Endpoint para grupos do utilizador logado
app.get("/api/grupos", async (req, res) => {
  const userId = req.session?.user?.id;
  if (!userId) return res.status(401).json({ error: "Não autenticado" });

  const grupoContainer = client.database("gestao_despesas").container("grupos");
  const { resources } = await grupoContainer.items
    .query({
      query: "SELECT * FROM c WHERE ARRAY_CONTAINS(c.membros, @id)",
      parameters: [{ name: "@id", value: userId }]
    }).fetchAll();

  res.json(resources);
});

// Endpoint para adicionar despesa
app.post("/api/despesas", async (req, res) => {
  const userId = req.session?.user?.id;
  if (!userId) return res.status(401).json({ error: "Não autenticado" });

  const { descricao, valor, categoria, grupo } = req.body;
  const despesaContainer = client.database("gestao_despesas").container("transacoes");

  const novaDespesa = {
    id: uuidv4(),
    descricao,
    valor: Number(valor),
    categoria,
    grupo: grupo || null,
    utilizador: userId,
    data: new Date().toISOString()
  };

  await despesaContainer.items.create(novaDespesa);
  res.status(201).json({ mensagem: "Despesa adicionada com sucesso" });
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error("Erro ao terminar sessão:", err);
    res.redirect("/");
  });
});

// Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor a correr em http://localhost:${PORT}`);
});
