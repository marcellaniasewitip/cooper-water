import org.jetbrains.kotlin.gradle.dsl.JvmTarget

/**
 * Shared Android library used by both Cooper Waters apps (customer-android, driver-android).
 * Included from each app's settings.gradle.kts as project ":core".
 *
 * Everything outside the `com.cooperwaters.core.android` package is plain Kotlin/JVM (no android.*
 * imports) so it can be unit-tested on the JVM; Android-specific code lives in `core.android`.
 */
plugins {
    alias(libs.plugins.android.library)
    alias(libs.plugins.kotlin.android)
    alias(libs.plugins.kotlin.compose)
    alias(libs.plugins.kotlin.serialization)
}

android {
    namespace = "com.cooperwaters.core"
    compileSdk = 35

    defaultConfig {
        minSdk = 24
        consumerProguardFiles("consumer-rules.pro")
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
        isCoreLibraryDesugaringEnabled = true
    }

    buildFeatures {
        compose = true
    }

    testOptions {
        unitTests.isReturnDefaultValues = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    coreLibraryDesugaring(libs.desugar.jdk.libs)

    api(libs.kotlinx.coroutines.android)
    api(libs.kotlinx.serialization.json)
    api(libs.okhttp)
    implementation(libs.okhttp.logging)
    api(libs.retrofit)
    api(libs.retrofit.kotlinx.serialization)
    api(libs.socketio.client) {
        // Android ships org.json; the artifact on Maven Central would clash with it.
        exclude(group = "org.json", module = "json")
    }

    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.security.crypto)
    api(libs.androidx.lifecycle.viewmodel.compose)
    api(libs.androidx.lifecycle.runtime.compose)

    api(platform(libs.androidx.compose.bom))
    api(libs.androidx.compose.ui)
    api(libs.androidx.compose.material3)
    api(libs.androidx.compose.ui.tooling.preview)
    api(libs.osmdroid)
    api(libs.maps.compose)
    api(libs.play.services.maps)

    api(platform(libs.firebase.bom))
    api(libs.firebase.messaging)

    testImplementation(libs.junit)
    testImplementation(libs.kotlinx.coroutines.test)
    testImplementation(libs.okhttp.mockwebserver)
}
