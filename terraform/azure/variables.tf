/**
 * Variables for TomoriBot Azure infrastructure.
 * Defaults target the Azure for Students free-service footprint from the
 * Azure migration plan.
 */

variable "azure_subscription_id" {
  description = "Azure subscription ID. In CI, set with TF_VAR_azure_subscription_id from AZURE_SUBSCRIPTION_ID."
  type        = string
}

variable "azure_location" {
  description = "Azure region for all regional resources."
  type        = string
  default     = "japanwest"
}

variable "environment" {
  description = "Environment name (production, staging, development)."
  type        = string
  default     = "production"
}

variable "name_prefix" {
  description = "Prefix used for Azure resource names."
  type        = string
  default     = "tomoribot"
}

variable "resource_group_name" {
  description = "Azure resource group name for TomoriBot runtime resources."
  type        = string
  default     = "tomoribot-rg"
}

# --- Network ---

variable "vnet_address_space" {
  description = "CIDR block for the TomoriBot virtual network."
  type        = string
  default     = "10.80.0.0/16"
}

variable "vm_subnet_address_prefix" {
  description = "CIDR block for the VM subnet."
  type        = string
  default     = "10.80.1.0/24"
}

# --- VM ---

variable "vm_admin_ssh_public_key" {
  description = "Provisioning-only public key required by Azure. Public SSH is disabled; CI never receives the private key."
  type        = string

  validation {
    condition     = startswith(trimspace(var.vm_admin_ssh_public_key), "ssh-")
    error_message = "vm_admin_ssh_public_key must be an OpenSSH public key."
  }
}

variable "vm_admin_username" {
  description = "Linux admin user. Pinned by the Phase 2/3 interface contract."
  type        = string
  default     = "azureuser"

  validation {
    condition     = var.vm_admin_username == "azureuser"
    error_message = "vm_admin_username is pinned to azureuser by the Azure migration interface contract."
  }
}

variable "vm_size" {
  description = "Azure VM size. Pinned by the Azure migration locked design decisions."
  type        = string
  default     = "Standard_B2ats_v2"

  validation {
    condition     = var.vm_size == "Standard_B2ats_v2"
    error_message = "vm_size is pinned to Standard_B2ats_v2 by the Azure migration locked design decisions."
  }
}

# --- PostgreSQL Flexible Server ---

variable "postgres_server_name" {
  description = "Azure PostgreSQL Flexible Server name."
  type        = string
  default     = "tomoribot-postgres"
}

variable "postgres_version" {
  description = "Azure PostgreSQL major version."
  type        = string
  default     = "16"

  validation {
    condition     = var.postgres_version == "16"
    error_message = "postgres_version is pinned to 16 by the Azure migration locked design decisions."
  }
}

variable "postgres_sku_name" {
  description = "Azure PostgreSQL Flexible Server SKU."
  type        = string
  default     = "B_Standard_B1ms"

  validation {
    condition     = var.postgres_sku_name == "B_Standard_B1ms"
    error_message = "postgres_sku_name is pinned to B_Standard_B1ms by the Azure migration locked design decisions."
  }
}

variable "postgres_storage_mb" {
  description = "PostgreSQL storage size in MiB. 32768 MiB is the 32 GB free-tier target."
  type        = number
  default     = 32768

  validation {
    condition     = var.postgres_storage_mb == 32768
    error_message = "postgres_storage_mb is pinned to 32768 by the Azure migration locked design decisions."
  }
}

variable "postgres_database_name" {
  description = "Application database name created on the Flexible Server."
  type        = string
  default     = "tomoribot"
}

variable "postgres_admin_login" {
  description = "PostgreSQL administrator login created with the Flexible Server."
  type        = string
  default     = "tomoriadmin"
}

variable "postgres_admin_password" {
  description = "PostgreSQL administrator password. In CI, set with TF_VAR_postgres_admin_password from AZURE_POSTGRES_ADMIN_PASSWORD."
  type        = string
  sensitive   = true
}

variable "postgres_backup_retention_days" {
  description = "Automatic backup retention for PostgreSQL Flexible Server."
  type        = number
  default     = 7
}

variable "grafana_egress_ip" {
  description = "Exact public IPv4 address of the operator-managed Grafana datasource. Produces one exact-address PostgreSQL firewall rule."
  type        = string

  validation {
    condition     = can(regex("^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$", var.grafana_egress_ip)) && var.grafana_egress_ip != "0.0.0.0"
    error_message = "grafana_egress_ip must be one explicit non-zero IPv4 address."
  }
}
