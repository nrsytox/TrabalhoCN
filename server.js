require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const session = require("express-session");
const { CosmosClient } = require("@azure/cosmos");
const path = require("path");
const axios = require("axios");

const app = express();

// Middlewares
app.use(cors());
app.use(express.json());
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));

// Sessões
app.use(
  session({
    secret: "segredo-super-seguro",
    resave: false,
    saveUninitialized: true,
  })
);

// Cosmos DB config
const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const databaseId = "gestao_despesas";
const client = new CosmosClient({ endpoint, key });

// Containers
const usersContainer = client.database(databaseId).container("user");
const gruposContainer = client.database(databaseId).container("grupos");
const transacoesContainer = client.database(databaseId).container("transacoes");
const categoriasContainer = client.database(databaseId).container("categorias");

// Middleware de autenticação
function authMiddleware(req, res, next) {
  if (req.session.user) next();
  else res.status(401).json({ error: "Não autenticado" });
}

// Middleware para atualizar orçamento
app.use(async (req, res, next) => {
  if (!req.session.user) return next(); // Alterado para verificar session

  try {
    const userId = req.session.user.id;
    const { resource: user } = await usersContainer.item(userId, userId).read(); // Usar usersContainer

    if (!user) return next();

    const hoje = new Date();
    const ultimoReset = new Date(user.ultimo_reset);
    const primeiroDiaMesAtual = new Date(
      hoje.getFullYear(),
      hoje.getMonth(),
      1
    );

    // Reset se:
    // 1. O último reset foi no mês passado E
    // 2. Já estamos no dia 1 ou depois
    if (ultimoReset < primeiroDiaMesAtual && hoje >= primeiroDiaMesAtual) {
      user.orcamento_restante = user.orcamento_mensal;
      user.ultimo_reset = hoje.toISOString();
      await usersContainer.item(userId, userId).replace(user);

      // Atualiza a sessão
      req.session.user.orcamento_restante = user.orcamento_restante;
    }

    req.user = user;
    next();
  } catch (err) {
    console.error("Erro no middleware de reset:", err);
    next();
  }
});

// ======================= ROTAS ========================== //

// Rotas estáticas
app.get("/", (req, res) =>
  res.sendFile(path.join(__dirname, "public", "index.html"))
);
app.get("/dashboard", authMiddleware, (req, res) =>
  res.sendFile(path.join(__dirname, "public", "dashboard.html"))
);
app.get("/perfil", authMiddleware, (req, res) =>
  res.sendFile(path.join(__dirname, "public", "perfil.html"))
);

// API para obter dados do perfil
app.get("/api/perfil", authMiddleware, (req, res) => {
  res.json(req.session.user);
});

// Registar
app.post("/auth/register", async (req, res) => {
  const { nome, email, password, orcamento_mensal } = req.body;

  const { resources: existingUsers } = await usersContainer.items
    .query({
      query: "SELECT * FROM c WHERE c.email = @email",
      parameters: [{ name: "@email", value: email }],
    })
    .fetchAll();

  if (existingUsers.length > 0)
    return res.status(400).json({ message: "Email já registado" });

  const hashedPassword = await bcrypt.hash(password, 10);

  const newUser = {
    id: uuidv4(),
    nome,
    email,
    password: hashedPassword,
    orcamento_mensal: Number(orcamento_mensal),
    orcamento_restante: Number(orcamento_mensal),
    grupos: [],
    notificacoes: [],
    ultimo_reset: new Date().toISOString(),
  };

  await usersContainer.items.create(newUser);

  req.session.user = {
    id: newUser.id,
    nome: newUser.nome,
    email: newUser.email,
    orcamento_mensal: newUser.orcamento_mensal,
    orcamento_restante: newUser.orcamento_restante,
  };

  res.redirect("/dashboard");
});

// Login
app.post("/auth/login", async (req, res) => {
  const { email, password } = req.body;

  const { resources } = await usersContainer.items
    .query({
      query: "SELECT * FROM c WHERE c.email = @email",
      parameters: [{ name: "@email", value: email }],
    })
    .fetchAll();

  if (resources.length === 0)
    return res.status(401).json({ message: "Email não encontrado" });

  const user = resources[0];
  if (!(await bcrypt.compare(password, user.password)))
    return res.status(401).json({ message: "Password incorreta" });

  req.session.user = {
    id: user.id,
    nome: user.nome,
    email: user.email,
    orcamento_mensal: user.orcamento_mensal,
    orcamento_restante: user.orcamento_restante,
  };

  res.redirect("/dashboard");
});

// API para categorias
app.get("/api/categorias", async (req, res) => {
  const { resources } = await categoriasContainer.items
    .query("SELECT * FROM c")
    .fetchAll();
  res.json(resources);
});

// API para grupos
app.get("/api/grupos", authMiddleware, async (req, res) => {
  const { resources } = await gruposContainer.items
    .query({
      query: "SELECT * FROM c WHERE ARRAY_CONTAINS(c.membros, @id)",
      parameters: [{ name: "@id", value: req.session.user.id }],
    })
    .fetchAll();
  res.json(resources);
});

// API para criar grupos
app.post("/api/grupos", authMiddleware, async (req, res) => {
  try {
    const { nome, membros } = req.body;

    if (!nome || !Array.isArray(membros) || membros.length === 0) {
      return res
        .status(400)
        .json({ error: "Nome do grupo e membros são obrigatórios." });
    }

    const newGroup = {
      id: uuidv4(),
      nome,
      membros,
      criadorId: req.session.user.id,
      dataCriacao: new Date().toISOString(),
    };

    await gruposContainer.items.create(newGroup);
    res.status(201).json({ success: true, group: newGroup });
  } catch (error) {
    console.error("Erro ao criar grupo:", error);
    res.status(500).json({ error: "Erro ao criar grupo." });
  }
});

app.post("/api/despesas", authMiddleware, async (req, res) => {
  try {
    const { descricao, valor, categoria, grupo } = req.body;
    const userId = req.session.user.id;

    // 1. Verificar se é despesa de grupo
    let participantesIds = [userId];
    let valorPorParticipante = Number(valor);
    let numMembros = 1;

    if (grupo) {
      const { resource: grupoDoc } = await gruposContainer
        .item(grupo, grupo)
        .read();
      if (!grupoDoc) throw new Error("Grupo não encontrado");
      participantesIds = grupoDoc.membros;
      numMembros = participantesIds.length;
      valorPorParticipante = Number(valor) / numMembros;
    }

    // 2. Chamar HTTP Trigger para verificação
    const { data: verificacao } = await axios.post(
      process.env.HTTP_TRIGGER_URL,
      {
        valorTotal: Number(valor),
        orcamentoMensal: req.session.user.orcamento_mensal,
        orcamentoRestante: req.session.user.orcamento_restante,
        numMembros: numMembros,
      }
    );

    // 3. Atualizar usuários e registrar transação
    await Promise.all(
      participantesIds.map(async (participanteId) => {
        const { resource: user } = await usersContainer
          .item(participanteId, participanteId)
          .read();
        user.orcamento_restante -= valorPorParticipante;

        // Verificar se é o usuário atual e se há alerta
        if (participanteId === userId && verificacao.alerta) {
          user.notificacoes = [
            ...(user.notificacoes || []),
            {
              id: Date.now().toString(),
              tipo: verificacao.alerta.tipo,
              mensagem: verificacao.alerta.mensagem,
              data: new Date().toISOString(),
              lida: false,
            },
          ];
        }

        await usersContainer.item(participanteId, participanteId).replace(user);
      })
    );

    // 4. Registrar transação
    await transacoesContainer.items.create({
      id: uuidv4(),
      descricao,
      valor: Number(valor),
      valorIndividual: valorPorParticipante,
      categoriaId: categoria,
      pagadorId: userId,
      grupoId: grupo || null,
      participantes: participantesIds,
      data: new Date().toISOString(),
    });

    // 5. Atualizar sessão
    const { resource: updatedUser } = await usersContainer
      .item(userId, userId)
      .read();
    req.session.user.orcamento_restante = updatedUser.orcamento_restante;

    res.json({
      success: true,
      alerta: verificacao.alerta,
      orcamento_restante: updatedUser.orcamento_restante,
    });
  } catch (error) {
    console.error("Erro ao adicionar despesa:", error);
    res.status(500).json({ error: error.message });
  }
});

// API para notificações
app.get("/api/notificacoes", authMiddleware, async (req, res) => {
  try {
    const { resource: user } = await usersContainer
      .item(req.session.user.id, req.session.user.id)
      .read();
    res.json({ notificacoes: user.notificacoes || [] });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// API para marcar notificação como lida
app.put("/api/notificacoes/:id", authMiddleware, async (req, res) => {
  try {
    const { resource: user } = await usersContainer
      .item(req.session.user.id, req.session.user.id)
      .read();
    user.notificacoes = (user.notificacoes || []).map((not) =>
      not.id === req.params.id ? { ...not, lida: true } : not
    );
    await usersContainer
      .item(req.session.user.id, req.session.user.id)
      .replace(user);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

//Endpoint para obter transações
app.get("/api/transacoes", authMiddleware, async (req, res) => {
  const { userId, limit = 5 } = req.query;
  const { resources } = await transacoesContainer.items
    .query({
      query:
        "SELECT TOP @limit * FROM c WHERE ARRAY_CONTAINS(c.participantes, @userId) ORDER BY c.data DESC",
      parameters: [
        { name: "@limit", value: parseInt(limit) },
        { name: "@userId", value: userId },
      ],
    })
    .fetchAll();
  res.json(resources);
});

// Logout
app.get("/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error("Erro ao terminar sessão:", err);
    res.json({ success: true });
  });
});

// Servidor
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor a correr em http://localhost:${PORT}`);
});
