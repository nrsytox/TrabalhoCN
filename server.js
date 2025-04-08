require("dotenv").config();
const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const { v4: uuidv4 } = require("uuid");
const { CosmosClient } = require("@azure/cosmos");
const path = require("path");

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static("public"));
app.use(express.urlencoded({ extended: true }));


// CosmosDB
const endpoint = process.env.COSMOS_ENDPOINT;
const key = process.env.COSMOS_KEY;
const databaseId = "gestao_despesas";
const containerId = "user";

const client = new CosmosClient({ endpoint, key });
const container = client.database(databaseId).container(containerId);

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
  res.status(201).json({ message: "Registo feito com sucesso!" });
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

  res.status(201).json({
    message: "Login com sucesso",
    user: {
      id: user.id,
      nome: user.nome,
      email: user.email,
    }
  });
});

// Página inicial
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Servidor a correr em http://localhost:${PORT}`);
});
